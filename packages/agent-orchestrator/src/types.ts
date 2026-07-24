import type {
  AgentTask,
  IsoTimestamp,
  TaskId,
  WorkspaceId,
  WorktreeId,
} from "@omniharness/shared-types";

/** What a task is for. Review/critic tasks conventionally depend on their subject. */
export type TaskKind = "execute" | "review" | "critic";

/** Progress events streamed by the runner while a task executes. */
export type TaskProgressEvent =
  | { readonly type: "heartbeat" }
  | { readonly type: "note"; readonly message: string }
  | { readonly type: "tool_call"; readonly signature: string }
  | {
      readonly type: "usage";
      readonly tokens?: number;
      readonly costUsd?: number;
      readonly toolCalls?: number;
      readonly durationMs?: number;
    };

export interface TaskRunnerContext {
  /** Aborted when the task is paused, cancelled, budget-tripped or dead-loop-tripped. */
  readonly signal: AbortSignal;
  /** Emit progress; also feeds heartbeat, usage accounting and dead-loop detection. */
  readonly onProgress: (event: TaskProgressEvent) => void;
}

export type TaskRunOutcome = { readonly result: string } | { readonly error: string };

/**
 * Implemented by the daemon: spawns an isolated agent session (possibly inside
 * a worktree) for the task and resolves with its outcome. Must honor
 * `ctx.signal` — the orchestrator aborts it on pause/cancel/budget/dead-loop.
 */
export interface TaskRunner {
  run(task: AgentTask, ctx: TaskRunnerContext): Promise<TaskRunOutcome>;
}

export interface WorktreeAllocation {
  readonly worktreeId: WorktreeId;
  readonly path: string;
}

/**
 * Coordinates git worktrees for task isolation. The orchestrator calls
 * acquire/release around each run but never manages git itself.
 */
export interface WorktreeAllocator {
  acquire(workspaceId: WorkspaceId, taskId: TaskId): Promise<WorktreeAllocation>;
  release(worktreeId: WorktreeId): Promise<void> | void;
}

/**
 * Pluggable dead-loop detector. One instance per task run; fed every tool-call
 * signature in the progress stream. Returns a human-readable reason when a
 * loop is detected, null otherwise.
 */
export interface DeadLoopDetector {
  observe(toolCallSignature: string): string | null;
}

/** Default detector: N identical consecutive tool-call signatures (default 5). */
export class ConsecutiveIdenticalCallDetector implements DeadLoopDetector {
  private readonly threshold: number;
  private last: string | null = null;
  private streak = 0;

  constructor(threshold = 5) {
    this.threshold = threshold;
  }

  observe(toolCallSignature: string): string | null {
    if (toolCallSignature === this.last) {
      this.streak += 1;
    } else {
      this.last = toolCallSignature;
      this.streak = 1;
    }
    if (this.streak >= this.threshold) {
      return (
        `dead loop: tool call "${toolCallSignature}" repeated ` +
        `${this.streak} times consecutively`
      );
    }
    return null;
  }
}

export interface TaskUsageDelta {
  readonly tokens?: number;
  readonly costUsd?: number;
  readonly toolCalls?: number;
  readonly durationMs?: number;
}

export interface CollectedTaskResult {
  readonly taskId: TaskId;
  readonly parentTaskId: TaskId | null;
  readonly kind: TaskKind;
  readonly objective: string;
  readonly status: AgentTask["status"];
  readonly dependencies: TaskId[];
  readonly result?: string;
  readonly error?: string;
}

export interface TaskRunRecord {
  readonly taskId: TaskId;
  readonly at: IsoTimestamp;
  readonly event: TaskProgressEvent;
}
