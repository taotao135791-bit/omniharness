import type {
  AgentId,
  ArtifactId,
  CheckpointId,
  IsoTimestamp,
  TaskId,
  WorkspaceId,
  WorktreeId,
} from "./ids.js";

export type TaskStatus =
  | "pending"
  | "blocked"
  | "ready"
  | "running"
  | "paused"
  | "awaiting_human"
  | "completed"
  | "failed"
  | "cancelled";

export interface TaskBudget {
  maxTokens?: number;
  maxCostUsd?: number;
  maxToolCalls?: number;
  maxDurationMs?: number;
}

export interface AgentTask {
  id: TaskId;
  parentTaskId: TaskId | null;
  objective: string;
  status: TaskStatus;
  dependencies: TaskId[];
  assignedAgentId: AgentId | null;
  workspaceId: WorkspaceId;
  worktreeId: WorktreeId | null;
  allowedTools: string[] | null; // null = inherit from parent
  budget: TaskBudget;
  checkpoints: CheckpointId[];
  artifacts: ArtifactId[];
  result?: string;
  error?: string;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  /** Consumed budget so far. */
  consumed: {
    tokens: number;
    costUsd: number;
    toolCalls: number;
    durationMs: number;
  };
}
