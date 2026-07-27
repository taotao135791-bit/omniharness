import type { TaskId } from "@omniharness/shared-types";

/** Base class for all orchestrator errors. */
export class OrchestratorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class TaskNotFoundError extends OrchestratorError {
  readonly taskId: TaskId;
  constructor(taskId: TaskId) {
    super(`task not found: ${taskId}`);
    this.taskId = taskId;
  }
}

/** A create/retry would introduce a cycle into the dependency graph. */
export class CyclicDependencyError extends OrchestratorError {
  readonly taskId: TaskId;
  readonly cycle: TaskId[];
  constructor(taskId: TaskId, cycle: TaskId[]) {
    super(`dependency cycle involving ${taskId}: ${cycle.join(" -> ")}`);
    this.taskId = taskId;
    this.cycle = cycle;
  }
}

/**
 * A sub-agent may never widen its parent's tool scope: the child's
 * allowedTools must be a subset of the parent's effective set.
 */
export class PermissionWideningError extends OrchestratorError {
  readonly taskId: TaskId;
  readonly parentTaskId: TaskId;
  readonly extraTools: string[];
  constructor(taskId: TaskId, parentTaskId: TaskId, extraTools: string[]) {
    super(
      `task ${taskId} widens parent ${parentTaskId} tool scope: ` +
        `disallowed tools [${extraTools.join(", ")}]`,
    );
    this.taskId = taskId;
    this.parentTaskId = parentTaskId;
    this.extraTools = extraTools;
  }
}

export type BudgetDimension = "tokens" | "costUsd" | "toolCalls" | "durationMs";

/** Thrown when a task's consumed budget exceeds its configured limit. */
export class BudgetExceededError extends OrchestratorError {
  readonly taskId: TaskId;
  readonly dimension: BudgetDimension;
  readonly limit: number;
  readonly consumed: number;
  constructor(taskId: TaskId, dimension: BudgetDimension, limit: number, consumed: number) {
    super(`task ${taskId} exceeded ${dimension} budget: ` + `${consumed} > ${limit}`);
    this.taskId = taskId;
    this.dimension = dimension;
    this.limit = limit;
    this.consumed = consumed;
  }
}

/** Lifecycle transition that is not valid from the task's current status. */
export class InvalidTaskStateError extends OrchestratorError {
  readonly taskId: TaskId;
  constructor(taskId: TaskId, message: string) {
    super(`task ${taskId}: ${message}`);
    this.taskId = taskId;
  }
}
