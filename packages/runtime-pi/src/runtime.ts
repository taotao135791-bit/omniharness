import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentMessage, ToolExecutionMode } from "@earendil-works/pi-agent-core";
import { DEFAULT_COMPACTION_SETTINGS } from "@earendil-works/pi-agent-core";
import type { CompactionSettings } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ModelRouter } from "@omniharness/model-gateway";
import type {
  ApprovalGate,
  AuditSink,
  PolicyEvaluator,
  ToolRegistry,
} from "@omniharness/tool-runtime";
import { ToolRuntime } from "@omniharness/tool-runtime";
import type { ModelId, SessionId, ToolCallId, Workspace } from "@omniharness/shared-types";
import { createCompactionTransform } from "./compaction.js";
import type { CompactionTransform } from "./compaction.js";
import type { RuntimeEvent, StartRunInput } from "./events.js";
import { createRouterStreamFn, toPiModel } from "./model-bridge.js";
import { createAgentTools } from "./tool-bridge.js";
import type { BridgedToolCallRecord, BridgedToolCallStatus, ToolBridgeRunContext } from "./tool-bridge.js";

export interface RecordedMessage {
  messageId: string;
  role: "user" | "assistant";
  text: string;
}

export interface RecordedToolCall {
  toolCallId: string;
  toolName: string;
  argumentsJson: string;
  status: BridgedToolCallStatus;
  output: string;
  durationMs: number;
}

/**
 * Persistence seam. The daemon implements this over session-store; the
 * runtime itself stays storage-free. Hook failures are swallowed — recording
 * must never break a run.
 */
export interface RunRecorder {
  recordMessage?(runId: string, message: RecordedMessage): void | Promise<void>;
  recordToolCall?(runId: string, call: RecordedToolCall): void | Promise<void>;
}

export interface PiAgentRuntimeOptions {
  /** All model access goes through this router (roles, fallback, budgets). */
  router: ModelRouter;
  registry: ToolRegistry;
  /** Policy evaluator for the internal ToolRuntime pipeline. */
  policy: PolicyEvaluator;
  /** Approval gate for ask_* policy decisions; without it they are denied. */
  approvalGate?: ApprovalGate;
  auditSink?: AuditSink;
  toolRuntimeOptions?: { maxOutputChars?: number; defaultTimeoutMs?: number };
  /** Workspace every tool execution is scoped to. */
  workspace: Workspace;
  /** Agent id reported in events and policy contexts. */
  agentId?: string;
  /** Base system prompt; buildContext sections are appended per run. */
  systemPrompt?: string;
  /**
   * Skills/memory hook: returns extra system-prompt sections (memory block,
   * skill bodies, AGENTS.md content) supplied by the daemon. The runtime
   * itself knows nothing about memory or skills.
   */
  buildContext?: (sessionId: SessionId) => string[] | Promise<string[]>;
  recorder?: RunRecorder;
  /** Threshold compaction overrides; false disables compaction. */
  compaction?: Partial<CompactionSettings> | false;
  toolExecution?: ToolExecutionMode;
}

interface RunState {
  runId: string;
  sessionId: SessionId;
  queue: EventQueue<RuntimeEvent>;
  interrupted: boolean;
  ended: boolean;
  failure?: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  sawCost: boolean;
  currentAssistantMessageId: string | undefined;
  messageCounter: number;
}

interface SessionState {
  sessionId: SessionId;
  agent: Agent;
  compaction?: CompactionTransform;
  toolBridgeContext: ToolBridgeRunContext;
  toolRecords: Map<string, BridgedToolCallRecord>;
  activeRunId: string | null;
}

class EventQueue<T> implements AsyncIterable<T> {
  private readonly buffer: T[] = [];
  private readonly waiters: Array<() => void> = [];
  private closed = false;

  push(item: T): void {
    this.buffer.push(item);
    this.wake();
  }

  close(): void {
    this.closed = true;
    this.wake();
  }

  private wake(): void {
    const waiters = this.waiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    for (;;) {
      const item = this.buffer.shift();
      if (item !== undefined) {
        yield item;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
      });
    }
  }
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function resultText(result: unknown): string {
  if (typeof result !== "object" || result === null) return "";
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } => {
      return (
        typeof part === "object" &&
        part !== null &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string"
      );
    })
    .map((part) => part.text)
    .join("");
}

/**
 * Daemon-facing agent runner: Pi is the agent kernel (loop, steering queues,
 * message protocol), while models, tools, policy and persistence stay inside
 * OmniHarness packages.
 *
 * One Pi `Agent` is kept per session, so the transcript (and queued
 * steering/follow-up messages) survive across runs. One active run per
 * session.
 */
export class PiAgentRuntime {
  private readonly options: PiAgentRuntimeOptions;
  private readonly toolRuntime: ToolRuntime;
  private readonly agentId: string;
  private readonly sessions = new Map<SessionId, SessionState>();
  private readonly runs = new Map<string, RunState>();
  private runCounter = 0;

  constructor(options: PiAgentRuntimeOptions) {
    this.options = options;
    this.agentId = options.agentId ?? "pi";
    this.toolRuntime = new ToolRuntime(options.registry, {
      policy: options.policy,
      ...(options.approvalGate !== undefined ? { approval: options.approvalGate } : {}),
      ...(options.auditSink !== undefined ? { onAudit: options.auditSink } : {}),
      ...(options.toolRuntimeOptions?.maxOutputChars !== undefined
        ? { maxOutputChars: options.toolRuntimeOptions.maxOutputChars }
        : {}),
      ...(options.toolRuntimeOptions?.defaultTimeoutMs !== undefined
        ? { defaultTimeoutMs: options.toolRuntimeOptions.defaultTimeoutMs }
        : {}),
    });
  }

  /** Start a run; returns the run's event stream (first event: run.started). */
  startRun(input: StartRunInput): AsyncIterable<RuntimeEvent> {
    const runId = input.runId ?? `run_${Date.now().toString(36)}_${++this.runCounter}`;
    const queue = new EventQueue<RuntimeEvent>();
    const run: RunState = {
      runId,
      sessionId: input.sessionId,
      queue,
      interrupted: false,
      ended: false,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      sawCost: false,
      currentAssistantMessageId: undefined,
      messageCounter: 0,
    };
    this.runs.set(runId, run);

    let session: SessionState;
    try {
      session = this.getOrCreateSession(input.sessionId);
    } catch (error) {
      this.failEarly(run, error);
      return queue;
    }
    if (session.activeRunId !== null) {
      this.failEarly(run, new Error(`Session ${input.sessionId} already has an active run`));
      return queue;
    }
    session.activeRunId = runId;

    void this.executeRun(session, run, input).catch((error: unknown) => {
      run.failure = error instanceof Error ? error.message : String(error);
      this.finishRun(session, run);
    });
    return queue;
  }

  /** Inject user input mid-run (queued into Pi's steering queue). */
  steer(runId: string, input: string): boolean {
    const session = this.sessionForRun(runId);
    if (session === undefined) return false;
    session.agent.steer({ role: "user", content: input, timestamp: Date.now() });
    const run = this.runs.get(runId);
    if (run !== undefined) {
      this.push(run, { type: "run.steered", sessionId: run.sessionId, runId });
    }
    return true;
  }

  /** Queue user input to run after the agent would otherwise stop. */
  enqueueFollowUp(runId: string, input: string): boolean {
    const session = this.sessionForRun(runId);
    if (session === undefined) return false;
    session.agent.followUp({ role: "user", content: input, timestamp: Date.now() });
    return true;
  }

  /** Abort a run cleanly; its event stream ends with run.failed. */
  interrupt(runId: string): boolean {
    const session = this.sessionForRun(runId);
    const run = this.runs.get(runId);
    if (session === undefined || run === undefined || run.ended) return false;
    run.interrupted = true;
    session.agent.abort();
    return true;
  }

  hasActiveRun(sessionId: SessionId): boolean {
    return this.sessions.get(sessionId)?.activeRunId !== null;
  }

  /** Current transcript for a session (empty for unknown sessions). */
  transcript(sessionId: SessionId): AgentMessage[] {
    return [...(this.sessions.get(sessionId)?.agent.state.messages ?? [])];
  }

  /** Abort all active runs and forget all sessions. */
  dispose(): void {
    for (const session of this.sessions.values()) {
      session.agent.abort();
    }
    this.sessions.clear();
  }

  private failEarly(run: RunState, error: unknown): void {
    this.runs.delete(run.runId);
    run.queue.push({
      type: "run.failed",
      sessionId: run.sessionId,
      runId: run.runId,
      error: error instanceof Error ? error.message : String(error),
    });
    run.ended = true;
    run.queue.close();
  }

  private sessionForRun(runId: string): SessionState | undefined {
    const run = this.runs.get(runId);
    if (run === undefined || run.ended) return undefined;
    return this.sessions.get(run.sessionId);
  }

  private activeRun(sessionId: SessionId): RunState | undefined {
    const session = this.sessions.get(sessionId);
    if (session?.activeRunId == null) return undefined;
    const run = this.runs.get(session.activeRunId);
    return run !== undefined && !run.ended ? run : undefined;
  }

  private push(run: RunState, event: RuntimeEvent): void {
    if (!run.ended) run.queue.push(event);
  }

  private getOrCreateSession(sessionId: SessionId): SessionState {
    const existing = this.sessions.get(sessionId);
    if (existing !== undefined) return existing;

    const primary = this.options.router.resolveChain("primary")[0];
    if (primary === undefined) {
      throw new Error('No model bound to role "primary" on the ModelRouter');
    }

    const toolBridgeContext: ToolBridgeRunContext = {
      runId: "",
      sessionId,
      agentId: this.agentId,
      workspace: this.options.workspace,
      emitOutput: (toolCallId, chunk, stream) => {
        const run = this.activeRun(sessionId);
        if (run === undefined) return;
        this.push(run, {
          type: "tool.call.output",
          sessionId,
          runId: run.runId,
          toolCallId: toolCallId as ToolCallId,
          chunk,
          stream,
        });
      },
    };
    const toolRecords = new Map<string, BridgedToolCallRecord>();

    let compaction: CompactionTransform | undefined;
    if (this.options.compaction !== false) {
      const settings: CompactionSettings = {
        ...DEFAULT_COMPACTION_SETTINGS,
        ...(this.options.compaction ?? {}),
      };
      compaction = createCompactionTransform({
        router: this.options.router,
        contextWindow: primary.capabilities.contextWindow,
        settings,
        hooks: {
          onCompacting: (beforeTokens) => {
            const run = this.activeRun(sessionId);
            if (run !== undefined) {
              this.push(run, { type: "run.compacting", sessionId, runId: run.runId, beforeTokens });
            }
          },
          onCompacted: (afterTokens) => {
            const run = this.activeRun(sessionId);
            if (run !== undefined) {
              this.push(run, { type: "run.compacted", sessionId, runId: run.runId, afterTokens });
            }
          },
        },
      });
    }

    const agent = new Agent({
      initialState: {
        systemPrompt: this.options.systemPrompt ?? "",
        model: toPiModel(primary),
        tools: createAgentTools(
          this.options.registry,
          this.toolRuntime,
          () => toolBridgeContext,
          toolRecords,
        ),
      },
      streamFn: createRouterStreamFn(this.options.router, "primary"),
      ...(compaction !== undefined ? { transformContext: compaction.transformContext } : {}),
      ...(this.options.toolExecution !== undefined ? { toolExecution: this.options.toolExecution } : {}),
    });

    const session: SessionState = {
      sessionId,
      agent,
      toolBridgeContext,
      toolRecords,
      activeRunId: null,
      ...(compaction !== undefined ? { compaction } : {}),
    };
    this.sessions.set(sessionId, session);
    agent.subscribe((event) => {
      this.onAgentEvent(session, event);
    });
    return session;
  }

  private async executeRun(session: SessionState, run: RunState, input: StartRunInput): Promise<void> {
    const { sessionId, runId } = run;

    if (input.modelId !== undefined) {
      this.options.router.setSessionOverrides({ primary: input.modelId as ModelId });
    }

    const sections: string[] = [];
    if (this.options.systemPrompt !== undefined && this.options.systemPrompt !== "") {
      sections.push(this.options.systemPrompt);
    }
    if (this.options.buildContext !== undefined) {
      try {
        sections.push(...(await this.options.buildContext(sessionId)));
      } catch {
        // A failing context builder must not break the run.
      }
    }
    if (sections.length > 0) session.agent.state.systemPrompt = sections.join("\n\n");

    const modelId = this.options.router.resolveChain("primary")[0]?.id ?? "unresolved";
    this.push(run, {
      type: "run.started",
      sessionId,
      runId,
      agentId: this.agentId,
      modelId,
    });

    const userMessageId = `msg_${++run.messageCounter}`;
    this.push(run, { type: "message.started", sessionId, runId, messageId: userMessageId, role: "user" });
    for (const attachment of input.attachments ?? []) {
      this.push(run, {
        type: "message.attachment",
        sessionId,
        runId,
        messageId: userMessageId,
        uri: attachment.uri,
        mimeType: attachment.mimeType,
      });
    }
    this.push(run, { type: "message.completed", sessionId, runId, messageId: userMessageId });
    this.record(run, (recorder) =>
      recorder.recordMessage?.(runId, { messageId: userMessageId, role: "user", text: input.input }),
    );

    let text = input.input;
    for (const attachment of input.attachments ?? []) {
      text += `\n[Attachment${attachment.name !== undefined ? ` ${attachment.name}` : ""} (${attachment.mimeType}): ${attachment.uri}]`;
    }

    session.toolBridgeContext.runId = runId;
    const onExternalAbort = (): void => {
      this.interrupt(runId);
    };
    if (input.signal !== undefined) {
      if (input.signal.aborted) {
        this.interrupt(runId);
      } else {
        input.signal.addEventListener("abort", onExternalAbort, { once: true });
      }
    }
    try {
      await session.agent.prompt(text);
      // Safety net: if the loop ended without agent_end (unexpected throw
      // path), close the run here. Normally a no-op.
      if (!run.ended) {
        run.failure = session.agent.state.errorMessage ?? "Run ended without a terminal event";
        this.finishRun(session, run);
      }
    } finally {
      input.signal?.removeEventListener("abort", onExternalAbort);
    }
  }

  private onAgentEvent(session: SessionState, event: import("@earendil-works/pi-agent-core").AgentEvent): void {
    const run = this.activeRun(session.sessionId);
    if (run === undefined) return;
    const base = { sessionId: run.sessionId, runId: run.runId };

    switch (event.type) {
      case "message_start": {
        if (event.message.role !== "assistant") return;
        const messageId = `msg_${++run.messageCounter}`;
        run.currentAssistantMessageId = messageId;
        this.push(run, { ...base, type: "message.started", messageId, role: "assistant" });
        return;
      }
      case "message_update": {
        const messageId = run.currentAssistantMessageId;
        if (messageId === undefined) return;
        const streamEvent = event.assistantMessageEvent;
        if (streamEvent.type === "text_delta") {
          this.push(run, { ...base, type: "message.delta", messageId, delta: streamEvent.delta, channel: "text" });
        } else if (streamEvent.type === "thinking_delta") {
          this.push(run, {
            ...base,
            type: "message.delta",
            messageId,
            delta: streamEvent.delta,
            channel: "reasoning",
          });
        }
        return;
      }
      case "message_end": {
        const message = event.message;
        if (message.role !== "assistant") return;
        const messageId = run.currentAssistantMessageId ?? `msg_${++run.messageCounter}`;
        run.currentAssistantMessageId = undefined;
        run.inputTokens += message.usage.input;
        run.outputTokens += message.usage.output;
        if (message.usage.cost.total > 0) {
          run.costUsd += message.usage.cost.total;
          run.sawCost = true;
        }
        this.push(run, { ...base, type: "message.completed", messageId });
        if (message.stopReason === "error") {
          run.failure = message.errorMessage ?? "Model request failed";
        } else if (message.stopReason === "aborted") {
          run.failure = run.interrupted ? "Run interrupted" : "Run aborted";
        }
        this.record(run, (recorder) =>
          recorder.recordMessage?.(run.runId, {
            messageId,
            role: "assistant",
            text: assistantText(message),
          }),
        );
        return;
      }
      case "tool_execution_start": {
        this.push(run, {
          ...base,
          type: "tool.call.started",
          toolCallId: event.toolCallId as ToolCallId,
          toolName: event.toolName,
          argumentsJson: JSON.stringify(event.args ?? {}),
        });
        return;
      }
      case "tool_execution_end": {
        const toolCallId = event.toolCallId as ToolCallId;
        const record = session.toolRecords.get(event.toolCallId);
        session.toolRecords.delete(event.toolCallId);
        if (record !== undefined) {
          if (record.status === "completed") {
            this.push(run, {
              ...base,
              type: "tool.call.completed",
              toolCallId,
              resultJson: JSON.stringify({ output: record.output }),
              durationMs: record.durationMs,
            });
          } else if (record.status === "denied") {
            this.push(run, { ...base, type: "tool.call.denied", toolCallId, reason: record.output });
          } else {
            this.push(run, { ...base, type: "tool.call.failed", toolCallId, error: record.output });
          }
          this.record(run, (recorder) =>
            recorder.recordToolCall?.(run.runId, {
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              argumentsJson: "{}",
              status: record.status,
              output: record.output,
              durationMs: record.durationMs,
            }),
          );
          return;
        }
        // The call never reached our execute() (unknown tool, Pi-side
        // argument validation failure, or a blocked call).
        const text = resultText(event.result);
        if (event.isError) {
          this.push(run, { ...base, type: "tool.call.failed", toolCallId, error: text || "Tool call failed" });
        } else {
          this.push(run, {
            ...base,
            type: "tool.call.completed",
            toolCallId,
            resultJson: JSON.stringify({ output: text }),
            durationMs: 0,
          });
        }
        return;
      }
      case "agent_end": {
        // Persist any in-run compaction into the session transcript.
        const compacted = session.compaction?.applyToTranscript(session.agent.state.messages);
        if (compacted !== undefined) session.agent.state.messages = compacted;
        this.finishRun(session, run);
        return;
      }
      default:
        return;
    }
  }

  private finishRun(session: SessionState, run: RunState): void {
    if (run.ended) return;
    if (session.activeRunId === run.runId) session.activeRunId = null;
    this.runs.delete(run.runId);
    // Push the terminal event BEFORE marking the run ended; push() drops
    // events for ended runs.
    if (run.failure !== undefined) {
      run.queue.push({ type: "run.failed", sessionId: run.sessionId, runId: run.runId, error: run.failure });
    } else {
      run.queue.push({
        type: "run.completed",
        sessionId: run.sessionId,
        runId: run.runId,
        usage: {
          inputTokens: run.inputTokens,
          outputTokens: run.outputTokens,
          ...(run.sawCost ? { costUsd: run.costUsd } : {}),
        },
      });
    }
    run.ended = true;
    run.queue.close();
  }

  private record(run: RunState, fn: (recorder: RunRecorder) => void | Promise<void>): void {
    const recorder = this.options.recorder;
    if (recorder === undefined) return;
    try {
      void Promise.resolve(fn(recorder)).catch(() => {});
    } catch {
      // Recording must never break a run.
    }
  }
}
