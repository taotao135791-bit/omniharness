import type {
  ApprovalId,
  ApprovalRequest,
  Automation,
  AutomationId,
  AutomationRun,
  IsoTimestamp,
  SessionId,
  TaskId,
  ToolCallId,
} from "@omniharness/shared-types";

/**
 * All domain events. Every event is persisted in the event log with a monotonically
 * increasing `seq` before broadcast, so a reconnecting client can request
 * `events.since` and deterministically catch up.
 */
export type DomainEvent =
  | SessionEvent
  | MessageEvent
  | RunEvent
  | ToolEvent
  | ApprovalEvent
  | TaskEvent
  | ModelEvent
  | MemoryEvent
  | SkillEvent
  | AutomationEvent
  | SystemEvent;

export interface EventBase {
  /** Durable, monotonic per daemon instance (restored from the log on restart). */
  seq: number;
  at: IsoTimestamp;
}

export type SessionEvent = EventBase &
  (
    | { type: "session.created"; sessionId: SessionId; title: string }
    | { type: "session.updated"; sessionId: SessionId; title: string; tags: string[] }
    | { type: "session.archived"; sessionId: SessionId }
    | { type: "session.status"; sessionId: SessionId; status: string }
  );

export type MessageEvent = EventBase &
  (
    | { type: "message.started"; sessionId: SessionId; messageId: string; role: string }
    | { type: "message.delta"; sessionId: SessionId; messageId: string; delta: string; channel: "text" | "reasoning" }
    | { type: "message.completed"; sessionId: SessionId; messageId: string }
    | { type: "message.attachment"; sessionId: SessionId; messageId: string; uri: string; mimeType: string }
  );

export type RunEvent = EventBase &
  (
    | { type: "run.started"; sessionId: SessionId; runId: string; agentId: string; modelId: string }
    | { type: "run.paused"; sessionId: SessionId; runId: string }
    | { type: "run.resumed"; sessionId: SessionId; runId: string }
    | { type: "run.steered"; sessionId: SessionId; runId: string }
    | { type: "run.completed"; sessionId: SessionId; runId: string; usage: { inputTokens: number; outputTokens: number; costUsd?: number } }
    | { type: "run.failed"; sessionId: SessionId; runId: string; error: string }
    | { type: "run.compacting"; sessionId: SessionId; runId: string; beforeTokens: number }
    | { type: "run.compacted"; sessionId: SessionId; runId: string; afterTokens: number }
  );

export type ToolEvent = EventBase &
  (
    | { type: "tool.call.started"; sessionId: SessionId; toolCallId: ToolCallId; toolName: string; argumentsJson: string }
    | { type: "tool.call.output"; sessionId: SessionId; toolCallId: ToolCallId; chunk: string; stream: "stdout" | "stderr" }
    | { type: "tool.call.completed"; sessionId: SessionId; toolCallId: ToolCallId; resultJson: string; durationMs: number }
    | { type: "tool.call.failed"; sessionId: SessionId; toolCallId: ToolCallId; error: string }
    | { type: "tool.call.denied"; sessionId: SessionId; toolCallId: ToolCallId; reason: string }
  );

export type ApprovalEvent = EventBase &
  (
    | { type: "approval.requested"; approval: ApprovalRequest }
    | { type: "approval.resolved"; approvalId: ApprovalId; status: "approved" | "denied" | "expired" | "cancelled" }
  );

export type TaskEvent = EventBase &
  (
    | { type: "task.created"; taskId: TaskId; parentTaskId: TaskId | null; objective: string }
    | { type: "task.status"; taskId: TaskId; status: string }
    | { type: "task.progress"; taskId: TaskId; consumed: { tokens: number; costUsd: number; toolCalls: number } }
    | { type: "task.completed"; taskId: TaskId; result: string }
    | { type: "task.failed"; taskId: TaskId; error: string }
  );

export type ModelEvent = EventBase &
  (
    | { type: "model.changed"; sessionId: SessionId; modelId: string; role: string }
    | { type: "model.fallback"; sessionId: SessionId; fromModelId: string; toModelId: string; reason: string }
    | { type: "provider.health"; providerId: string; healthy: boolean; latencyMs?: number }
  );

export type MemoryEvent = EventBase &
  (
    | { type: "memory.proposed"; memoryId: string; summary: string }
    | { type: "memory.approved"; memoryId: string }
    | { type: "memory.rejected"; memoryId: string }
  );

export type SkillEvent = EventBase &
  (
    | { type: "skill.proposed"; proposalId: string; name: string }
    | { type: "skill.approved"; skillId: string }
    | { type: "skill.rejected"; proposalId: string }
  );

export type AutomationEvent = EventBase &
  (
    | { type: "automation.fired"; automationId: AutomationId; runId: string }
    | { type: "automation.run.completed"; automationId: AutomationId; runId: string; summary: string }
    | { type: "automation.run.failed"; automationId: AutomationId; runId: string; error: string }
    | { type: "automation.updated"; automation: Automation }
  );

export type SystemEvent = EventBase &
  (
    | { type: "daemon.heartbeat"; uptimeMs: number }
    | { type: "daemon.shutdown"; reason: string }
    | { type: "diagnostic"; level: "info" | "warn" | "error"; message: string; context?: Record<string, string> }
  );

export interface AutomationRunPage {
  runs: AutomationRun[];
  total: number;
}
