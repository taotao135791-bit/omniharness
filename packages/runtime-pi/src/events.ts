import type { ModelId, SessionId, ToolCallId } from "@omniharness/shared-types";

/**
 * Events emitted by {@link PiAgentRuntime.startRun}. These mirror the run,
 * message and tool event shapes of `@omniharness/agent-protocol`
 * (src/events.ts) but deliberately omit `seq`/`at` — the daemon stamps those
 * when it persists events to its log.
 */
export type RuntimeEvent =
  | { type: "run.started"; sessionId: SessionId; runId: string; agentId: string; modelId: string }
  | { type: "run.steered"; sessionId: SessionId; runId: string }
  | {
      type: "run.completed";
      sessionId: SessionId;
      runId: string;
      usage: { inputTokens: number; outputTokens: number; costUsd?: number };
    }
  | { type: "run.failed"; sessionId: SessionId; runId: string; error: string }
  | { type: "run.compacting"; sessionId: SessionId; runId: string; beforeTokens: number }
  | { type: "run.compacted"; sessionId: SessionId; runId: string; afterTokens: number }
  | {
      type: "message.started";
      sessionId: SessionId;
      runId: string;
      messageId: string;
      role: string;
    }
  | {
      type: "message.delta";
      sessionId: SessionId;
      runId: string;
      messageId: string;
      delta: string;
      channel: "text" | "reasoning";
    }
  | { type: "message.completed"; sessionId: SessionId; runId: string; messageId: string }
  | {
      type: "message.attachment";
      sessionId: SessionId;
      runId: string;
      messageId: string;
      uri: string;
      mimeType: string;
    }
  | {
      type: "tool.call.started";
      sessionId: SessionId;
      runId: string;
      toolCallId: ToolCallId;
      toolName: string;
      argumentsJson: string;
    }
  | {
      type: "tool.call.output";
      sessionId: SessionId;
      runId: string;
      toolCallId: ToolCallId;
      chunk: string;
      stream: "stdout" | "stderr";
    }
  | {
      type: "tool.call.completed";
      sessionId: SessionId;
      runId: string;
      toolCallId: ToolCallId;
      resultJson: string;
      durationMs: number;
    }
  | {
      type: "tool.call.failed";
      sessionId: SessionId;
      runId: string;
      toolCallId: ToolCallId;
      error: string;
    }
  | {
      type: "tool.call.denied";
      sessionId: SessionId;
      runId: string;
      toolCallId: ToolCallId;
      reason: string;
    };

/** A non-image attachment reference supplied by the daemon. */
export interface RuntimeAttachment {
  uri: string;
  mimeType: string;
  name?: string;
}

export interface StartRunInput {
  sessionId: SessionId;
  /** User prompt text. */
  input: string;
  attachments?: RuntimeAttachment[];
  /**
   * Optional model override for this run. Applied as the session-level
   * binding for the `primary` role on the router before the run starts.
   */
  modelId?: ModelId;
  /** Caller-chosen run id; generated when omitted. */
  runId?: string;
  /** External cancellation; aborting it interrupts the run. */
  signal?: AbortSignal;
}
