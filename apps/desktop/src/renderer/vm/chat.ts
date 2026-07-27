import type { DomainEvent } from "@omniharness/agent-protocol";
import type { Message, TokenUsage } from "@omniharness/shared-types";

/**
 * Chat view-model: a pure reducer turning daemon DomainEvents and history
 * snapshots into renderable chat state. No React, no DOM — unit-testable.
 */

export type ToolCallStatus = "running" | "completed" | "failed" | "denied";

export interface ToolCallState {
  id: string;
  name: string;
  argumentsJson: string;
  output: string;
  status: ToolCallStatus;
  durationMs: number | null;
  resultJson: string | null;
  error: string | null;
  /** Event seq at start, used to order tool calls inside the timeline. */
  seq: number;
}

export interface ChatMessageState {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  text: string;
  reasoning: string;
  streaming: boolean;
  modelId?: string;
  usage?: TokenUsage;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  hasCost: boolean;
}

export interface ChatState {
  messages: ChatMessageState[];
  toolCalls: ToolCallState[];
  /** Currently running run id; null when idle. */
  activeRunId: string | null;
  compacting: boolean;
  /** Set after run.compacted; cleared on next run.started. */
  compactionNote: string | null;
  totals: UsageTotals;
  lastError: string | null;
}

export function emptyChatState(): ChatState {
  return {
    messages: [],
    toolCalls: [],
    activeRunId: null,
    compacting: false,
    compactionNote: null,
    totals: { inputTokens: 0, outputTokens: 0, costUsd: 0, hasCost: false },
    lastError: null,
  };
}

function addUsage(totals: UsageTotals, u: TokenUsage): UsageTotals {
  return {
    inputTokens: totals.inputTokens + u.inputTokens,
    outputTokens: totals.outputTokens + u.outputTokens,
    costUsd: totals.costUsd + (u.costUsd ?? 0),
    hasCost: totals.hasCost || u.costUsd !== undefined,
  };
}

function upsertMessage(
  messages: ChatMessageState[],
  id: string,
  role: ChatMessageState["role"],
  patch: (m: ChatMessageState) => ChatMessageState,
): ChatMessageState[] {
  const idx = messages.findIndex((m) => m.id === id);
  if (idx === -1) {
    return [...messages, patch({ id, role, text: "", reasoning: "", streaming: false })];
  }
  const next = [...messages];
  next[idx] = patch(next[idx]!);
  return next;
}

function upsertToolCall(
  toolCalls: ToolCallState[],
  id: string,
  patch: (t: ToolCallState) => ToolCallState,
  seed: Omit<ToolCallState, "id">,
): ToolCallState[] {
  const idx = toolCalls.findIndex((t) => t.id === id);
  if (idx === -1) return [...toolCalls, patch({ id, ...seed })];
  const next = [...toolCalls];
  next[idx] = patch(next[idx]!);
  return next;
}

const toolSeed: Omit<ToolCallState, "id"> = {
  name: "tool",
  argumentsJson: "",
  output: "",
  status: "running",
  durationMs: null,
  resultJson: null,
  error: null,
  seq: 0,
};

/** Apply one domain event for the given session; returns unchanged state for foreign events. */
export function reduceChatEvent(state: ChatState, sessionId: string, event: DomainEvent): ChatState {
  switch (event.type) {
    case "message.started": {
      if (event.sessionId !== sessionId) return state;
      const role = event.role === "user" ? "user" : event.role === "system" ? "system" : "assistant";
      return {
        ...state,
        messages: upsertMessage(state.messages, event.messageId, role, (m) => ({
          ...m,
          streaming: true,
        })),
      };
    }
    case "message.delta": {
      if (event.sessionId !== sessionId) return state;
      return {
        ...state,
        messages: upsertMessage(state.messages, event.messageId, "assistant", (m) =>
          event.channel === "reasoning"
            ? { ...m, reasoning: m.reasoning + event.delta, streaming: true }
            : { ...m, text: m.text + event.delta, streaming: true },
        ),
      };
    }
    case "message.completed": {
      if (event.sessionId !== sessionId) return state;
      return {
        ...state,
        messages: upsertMessage(state.messages, event.messageId, "assistant", (m) => ({
          ...m,
          streaming: false,
        })),
      };
    }
    case "run.started": {
      if (event.sessionId !== sessionId) return state;
      return { ...state, activeRunId: event.runId, compactionNote: null, lastError: null };
    }
    case "run.paused":
    case "run.resumed":
    case "run.steered":
      return state;
    case "run.completed": {
      if (event.sessionId !== sessionId) return state;
      const usage: TokenUsage = {
        inputTokens: event.usage.inputTokens,
        outputTokens: event.usage.outputTokens,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        ...(event.usage.costUsd !== undefined ? { costUsd: event.usage.costUsd } : {}),
      };
      return {
        ...state,
        activeRunId: state.activeRunId === event.runId ? null : state.activeRunId,
        compacting: false,
        totals: addUsage(state.totals, usage),
        messages: state.messages.map((m) => (m.streaming ? { ...m, streaming: false } : m)),
      };
    }
    case "run.failed": {
      if (event.sessionId !== sessionId) return state;
      return {
        ...state,
        activeRunId: state.activeRunId === event.runId ? null : state.activeRunId,
        compacting: false,
        lastError: event.error,
        messages: state.messages.map((m) => (m.streaming ? { ...m, streaming: false } : m)),
      };
    }
    case "run.compacting": {
      if (event.sessionId !== sessionId) return state;
      return { ...state, compacting: true };
    }
    case "run.compacted": {
      if (event.sessionId !== sessionId) return state;
      return {
        ...state,
        compacting: false,
        compactionNote: `Context compacted to ${formatTokens(event.afterTokens)} tokens`,
      };
    }
    case "tool.call.started": {
      if (event.sessionId !== sessionId) return state;
      return {
        ...state,
        toolCalls: upsertToolCall(
          state.toolCalls,
          event.toolCallId,
          (t) => ({
            ...t,
            name: event.toolName,
            argumentsJson: event.argumentsJson,
            status: "running",
            seq: event.seq,
          }),
          { ...toolSeed, seq: event.seq },
        ),
      };
    }
    case "tool.call.output": {
      if (event.sessionId !== sessionId) return state;
      return {
        ...state,
        toolCalls: upsertToolCall(
          state.toolCalls,
          event.toolCallId,
          (t) => ({ ...t, output: t.output + event.chunk }),
          toolSeed,
        ),
      };
    }
    case "tool.call.completed": {
      if (event.sessionId !== sessionId) return state;
      return {
        ...state,
        toolCalls: upsertToolCall(
          state.toolCalls,
          event.toolCallId,
          (t) => ({
            ...t,
            status: "completed",
            durationMs: event.durationMs,
            resultJson: event.resultJson,
          }),
          toolSeed,
        ),
      };
    }
    case "tool.call.failed": {
      if (event.sessionId !== sessionId) return state;
      return {
        ...state,
        toolCalls: upsertToolCall(
          state.toolCalls,
          event.toolCallId,
          (t) => ({ ...t, status: "failed", error: event.error }),
          toolSeed,
        ),
      };
    }
    case "tool.call.denied": {
      if (event.sessionId !== sessionId) return state;
      return {
        ...state,
        toolCalls: upsertToolCall(
          state.toolCalls,
          event.toolCallId,
          (t) => ({ ...t, status: "denied", error: event.reason }),
          toolSeed,
        ),
      };
    }
    default:
      return state;
  }
}

/** Convert a session.messages history snapshot into chat state. */
export function chatStateFromHistory(messages: Message[]): ChatState {
  const state = emptyChatState();
  const toolCalls: ToolCallState[] = [];
  const out: ChatMessageState[] = [];
  for (const m of messages) {
    const role = m.role;
    let text = "";
    let reasoning = "";
    for (const part of m.parts) {
      if (part.type === "text") text += part.text ?? "";
      else if (part.type === "reasoning") reasoning += part.text ?? "";
      else if (part.type === "tool_call" && part.toolCallId) {
        toolCalls.push({
          id: part.toolCallId,
          name: part.toolName ?? "tool",
          argumentsJson: part.argumentsJson ?? "",
          output: "",
          status: "running",
          durationMs: null,
          resultJson: null,
          error: null,
          seq: 0,
        });
      } else if (part.type === "tool_result" && part.toolCallId) {
        const existing = toolCalls.find((t) => t.id === part.toolCallId);
        if (existing) {
          existing.status = part.isError ? "failed" : "completed";
          existing.resultJson = part.resultJson ?? null;
          if (part.isError) existing.error = part.resultJson ?? "tool error";
        }
      }
    }
    const msg: ChatMessageState = { id: m.id, role, text, reasoning, streaming: false };
    if (m.modelId !== undefined) msg.modelId = m.modelId;
    if (m.usage !== undefined) {
      msg.usage = m.usage;
      state.totals = addUsage(state.totals, m.usage);
    }
    out.push(msg);
  }
  state.messages = out;
  state.toolCalls = toolCalls;
  return state;
}

/** Append a locally-authored user message (echo before daemon confirms). */
export function appendUserMessage(state: ChatState, id: string, text: string): ChatState {
  return {
    ...state,
    messages: [...state.messages, { id, role: "user", text, reasoning: "", streaming: false }],
  };
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function formatCost(totals: UsageTotals): string {
  return totals.hasCost ? `$${totals.costUsd.toFixed(4)}` : "—";
}
