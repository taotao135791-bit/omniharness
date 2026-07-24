import { randomUUID } from "node:crypto";
import type {
  AgentId,
  AgentTask,
  IsoTimestamp,
  SessionId,
  TaskBudget,
  TaskId,
  WorkspaceId,
} from "@omniharness/shared-types";
import { nowIso } from "@omniharness/shared-types";
import type { TasksRepo } from "@omniharness/session-store";
import {
  BudgetExceededError,
  CyclicDependencyError,
  InvalidTaskStateError,
  PermissionWideningError,
  TaskNotFoundError,
  type BudgetDimension,
} from "./errors.js";
import type {
  CollectedTaskResult,
  DeadLoopDetector,
  TaskKind,
  TaskProgressEvent,
  TaskRunRecord,
  TaskRunner,
  TaskUsageDelta,
  WorktreeAllocation,
  WorktreeAllocator,
} from "./types.js";
import { ConsecutiveIdenticalCallDetector } from "./types.js";

export interface CreateTaskInput {
  readonly objective: string;
  readonly sessionId?: SessionId;
  readonly parentTaskId?: TaskId;
  readonly dependencies?: readonly TaskId[];
  /** null/omitted = inherit from parent; a child may never widen its parent's scope. */
  readonly allowedTools?: readonly string[] | null;
  readonly budget?: TaskBudget;
  readonly kind?: TaskKind;
  readonly assignedAgentId?: AgentId;
}

export interface TaskOrchestratorOptions {
  readonly store: TasksRepo;
  /** Workspace this orchestrator instance schedules tasks for. */
  readonly workspaceId: WorkspaceId;
  readonly runner: TaskRunner;
  readonly worktreeAllocator?: WorktreeAllocator;
  /** Default concurrency for runReady(). */
  readonly maxConcurrency?: number;
  /** Running tasks silent for longer than this are swept as zombies. Default 60s. */
  readonly zombieTtlMs?: number;
  /** Factory for the per-run dead-loop detector. */
  readonly deadLoopDetector?: () => DeadLoopDetector;
  readonly idGenerator?: () => TaskId;
  readonly clock?: () => Date;
}

interface TaskMeta {
  kind: TaskKind;
  sessionId: SessionId | null;
  attempts: number;
  lastProgressAt: IsoTimestamp | null;
  progress: TaskRunRecord[];
  detector: DeadLoopDetector | null;
}

interface BudgetViolation {
  readonly dimension: BudgetDimension;
  readonly limit: number;
  readonly consumed: number;
}

const TERMINAL: ReadonlySet<AgentTask["status"]> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

/**
 * Multi-agent task orchestrator. Owns task lifecycle, dependency scheduling,
 * budget enforcement, dead-loop/zombie detection and result aggregation on top
 * of the session-store tasks repo. Spawning agents and managing git worktrees
 * are delegated to the injected TaskRunner / WorktreeAllocator.
 *
 * Run-scoped state (progress streams, attempt counters, abort controllers,
 * task kinds) is in-memory; durable task state lives in the repo, and
 * `sweep()` on daemon start recovers tasks orphaned by a crash.
 */
export class TaskOrchestrator {
  private readonly store: TasksRepo;
  private readonly workspaceId: WorkspaceId;
  private readonly runner: TaskRunner;
  private readonly worktreeAllocator: WorktreeAllocator | null;
  private readonly maxConcurrency: number;
  private readonly zombieTtlMs: number;
  private readonly detectorFactory: () => DeadLoopDetector;
  private readonly idGenerator: () => TaskId;
  private readonly clock: () => Date;

  private readonly meta = new Map<TaskId, TaskMeta>();
  private readonly controllers = new Map<TaskId, AbortController>();
  private readonly startedAt = new Map<TaskId, IsoTimestamp>();

  constructor(options: TaskOrchestratorOptions) {
    this.store = options.store;
    this.workspaceId = options.workspaceId;
    this.runner = options.runner;
    this.worktreeAllocator = options.worktreeAllocator ?? null;
    this.maxConcurrency = options.maxConcurrency ?? 4;
    this.zombieTtlMs = options.zombieTtlMs ?? 60_000;
    this.detectorFactory =
      options.deadLoopDetector ?? (() => new ConsecutiveIdenticalCallDetector());
    this.idGenerator = options.idGenerator ?? (() => `task_${randomUUID()}` as TaskId);
    this.clock = options.clock ?? (() => new Date());
  }

  // ------------------------------------------------------------------ create

  createTask(input: CreateTaskInput): AgentTask {
    const id = this.idGenerator();
    const dependencies = [...new Set(input.dependencies ?? [])];

    if (dependencies.includes(id)) throw new CyclicDependencyError(id, [id]);

    let parent: AgentTask | null = null;
    if (input.parentTaskId !== undefined) {
      parent = this.store.get(input.parentTaskId) ?? null;
      if (parent === null) throw new TaskNotFoundError(input.parentTaskId);
    }
    for (const depId of dependencies) {
      if (this.store.get(depId) === undefined) throw new TaskNotFoundError(depId);
    }
    this.assertAcyclic(id, dependencies);

    const allowedTools = input.allowedTools ?? null;
    if (parent !== null && allowedTools !== null) {
      const parentTools = this.effectiveTools(parent);
      if (parentTools !== null) {
        const extra = allowedTools.filter((t) => !parentTools.includes(t));
        if (extra.length > 0) {
          throw new PermissionWideningError(id, parent.id, extra);
        }
      }
    }

    const now = this.clock().toISOString();
    const blocked = dependencies.some((depId) => {
      const dep = this.store.get(depId);
      return dep === undefined || dep.status !== "completed";
    });

    const task: AgentTask = {
      id,
      parentTaskId: parent?.id ?? null,
      objective: input.objective,
      status: blocked ? "blocked" : "ready",
      dependencies,
      assignedAgentId: input.assignedAgentId ?? null,
      workspaceId: this.workspaceId,
      worktreeId: null,
      allowedTools: allowedTools === null ? null : [...allowedTools],
      budget: input.budget ?? {},
      checkpoints: [],
      artifacts: [],
      createdAt: now,
      updatedAt: now,
      consumed: { tokens: 0, costUsd: 0, toolCalls: 0, durationMs: 0 },
    };
    this.store.put(task);
    const meta = this.metaFor(id);
    meta.kind = input.kind ?? "execute";
    meta.sessionId = input.sessionId ?? null;
    return task;
  }

  /** Standard execute → review chain: the review task depends on its subject. */
  scheduleWithReview(
    objective: string,
    options: Omit<CreateTaskInput, "objective" | "kind" | "dependencies"> = {},
  ): { execute: AgentTask; review: AgentTask } {
    const execute = this.createTask({ ...options, objective, kind: "execute" });
    const review = this.createTask({
      ...options,
      objective: `Review: ${objective}`,
      kind: "review",
      dependencies: [execute.id],
    });
    return { execute, review };
  }

  // ------------------------------------------------------------- scheduling

  /**
   * Tasks whose dependencies are all satisfied, in topological order.
   * Promotes newly unblocked tasks as a side effect.
   */
  readyTasks(workspaceId: WorkspaceId = this.workspaceId): AgentTask[] {
    this.refreshReady(workspaceId);
    const order = this.scheduleOrder(workspaceId);
    const rank = new Map<TaskId, number>(order.map((id, i) => [id, i]));
    return this.store
      .listByWorkspace(workspaceId, "ready")
      .sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
  }

  /** Kahn topological order over all non-terminal tasks of the workspace. */
  scheduleOrder(workspaceId: WorkspaceId = this.workspaceId): TaskId[] {
    const tasks = this.store
      .listByWorkspace(workspaceId)
      .filter((t) => !TERMINAL.has(t.status));
    const ids = new Set(tasks.map((t) => t.id));
    const indegree = new Map<TaskId, number>();
    const dependents = new Map<TaskId, TaskId[]>();
    for (const t of tasks) {
      const deps = t.dependencies.filter((d) => ids.has(d));
      indegree.set(t.id, deps.length);
      for (const d of deps) {
        const list = dependents.get(d) ?? [];
        list.push(t.id);
        dependents.set(d, list);
      }
    }
    const queue = tasks.filter((t) => (indegree.get(t.id) ?? 0) === 0).map((t) => t.id);
    const order: TaskId[] = [];
    while (queue.length > 0) {
      const id = queue.shift();
      if (id === undefined) break;
      order.push(id);
      for (const next of dependents.get(id) ?? []) {
        const deg = (indegree.get(next) ?? 0) - 1;
        indegree.set(next, deg);
        if (deg === 0) queue.push(next);
      }
    }
    return order;
  }

  /**
   * Run every currently ready task (and tasks unblocked along the way),
   * at most `concurrency` at a time. Resolves with the final task states.
   */
  async runReady(options: { concurrency?: number } = {}): Promise<AgentTask[]> {
    const concurrency = options.concurrency ?? this.maxConcurrency;
    const finished = new Map<TaskId, AgentTask>();
    for (;;) {
      const ready = this.readyTasks().filter(
        (t) => !finished.has(t.id) && !this.controllers.has(t.id),
      );
      if (ready.length === 0) break;
      let cursor = 0;
      const workers = Array.from({ length: Math.min(concurrency, ready.length) }, async () => {
        for (;;) {
          const task = ready[cursor];
          cursor += 1;
          if (task === undefined) return;
          try {
            finished.set(task.id, await this.run(task.id));
          } catch (err) {
            // e.g. budget already exceeded at start: fail and keep scheduling.
            if (err instanceof BudgetExceededError) {
              this.store.fail(task.id, err.message);
              finished.set(task.id, this.requireTask(task.id));
            } else {
              throw err;
            }
          }
        }
      });
      await Promise.all(workers);
    }
    return [...finished.values()];
  }

  // --------------------------------------------------------------- running

  /** Execute one ready task via the injected runner. Resolves with the final state. */
  async run(taskId: TaskId): Promise<AgentTask> {
    let task = this.requireTask(taskId);
    if (task.status === "blocked") this.refreshReady(task.workspaceId);
    task = this.requireTask(taskId);
    if (task.status !== "ready") {
      throw new InvalidTaskStateError(taskId, `cannot run from status "${task.status}"`);
    }
    const preViolation = this.budgetViolation(task);
    if (preViolation !== null) {
      this.store.fail(taskId, budgetMessage(preViolation));
      throw new BudgetExceededError(
        taskId,
        preViolation.dimension,
        preViolation.limit,
        preViolation.consumed,
      );
    }

    const meta = this.metaFor(taskId);
    meta.attempts += 1;
    meta.detector = this.detectorFactory();
    meta.lastProgressAt = this.clock().toISOString();
    meta.progress = [];

    const controller = new AbortController();
    this.controllers.set(taskId, controller);
    this.startedAt.set(taskId, this.clock().toISOString());

    let allocation: WorktreeAllocation | null = null;
    if (this.worktreeAllocator !== null) {
      allocation = await this.worktreeAllocator.acquire(task.workspaceId, task.id);
      task = { ...task, worktreeId: allocation.worktreeId };
    }

    const running: AgentTask = {
      ...task,
      status: "running",
      updatedAt: this.clock().toISOString(),
    };
    delete running.result;
    delete running.error;
    this.store.put(running);

    const onProgress = (event: TaskProgressEvent): void => {
      this.handleProgress(taskId, event);
    };

    try {
      const outcome = await this.runner.run(running, {
        signal: controller.signal,
        onProgress,
      });
      const current = this.requireTask(taskId);
      if (current.status === "running") {
        if ("result" in outcome) this.store.complete(taskId, outcome.result);
        else this.store.fail(taskId, outcome.error);
      }
    } catch (err) {
      const current = this.requireTask(taskId);
      if (current.status === "running") {
        this.store.fail(taskId, err instanceof Error ? err.message : String(err));
      }
    } finally {
      this.controllers.delete(taskId);
      this.startedAt.delete(taskId);
      if (allocation !== null && this.worktreeAllocator !== null) {
        await this.worktreeAllocator.release(allocation.worktreeId);
      }
      this.refreshReady(task.workspaceId);
    }
    return this.requireTask(taskId);
  }

  // --------------------------------------------------------------- budgets

  /**
   * Add consumed budget to a task. Throws BudgetExceededError when a limit is
   * crossed; a running task is additionally failed and aborted.
   */
  recordUsage(taskId: TaskId, delta: TaskUsageDelta): AgentTask {
    const task = this.requireTask(taskId);
    const updated: AgentTask = {
      ...task,
      consumed: {
        tokens: task.consumed.tokens + (delta.tokens ?? 0),
        costUsd: task.consumed.costUsd + (delta.costUsd ?? 0),
        toolCalls: task.consumed.toolCalls + (delta.toolCalls ?? 0),
        durationMs: task.consumed.durationMs + (delta.durationMs ?? 0),
      },
      updatedAt: this.clock().toISOString(),
    };
    this.store.put(updated);
    const violation = this.budgetViolation(updated);
    if (violation !== null) {
      if (updated.status === "running") {
        this.trip(taskId, budgetMessage(violation));
      }
      throw new BudgetExceededError(
        taskId,
        violation.dimension,
        violation.limit,
        violation.consumed,
      );
    }
    return updated;
  }

  // ------------------------------------------------------------- lifecycle

  pause(taskId: TaskId): AgentTask {
    const task = this.requireTask(taskId);
    if (task.status !== "running") {
      throw new InvalidTaskStateError(taskId, `cannot pause from status "${task.status}"`);
    }
    this.store.setStatus(taskId, "paused");
    this.controllers.get(taskId)?.abort();
    return this.requireTask(taskId);
  }

  resume(taskId: TaskId): AgentTask {
    const task = this.requireTask(taskId);
    if (task.status !== "paused" && task.status !== "awaiting_human") {
      throw new InvalidTaskStateError(taskId, `cannot resume from status "${task.status}"`);
    }
    this.store.setStatus(taskId, "ready");
    return this.requireTask(taskId);
  }

  cancel(taskId: TaskId): AgentTask {
    const task = this.requireTask(taskId);
    if (TERMINAL.has(task.status)) {
      throw new InvalidTaskStateError(taskId, `cannot cancel from status "${task.status}"`);
    }
    this.store.setStatus(taskId, "cancelled");
    this.controllers.get(taskId)?.abort();
    return this.requireTask(taskId);
  }

  /** Hand a task over to a human operator. */
  handToHuman(taskId: TaskId): AgentTask {
    const task = this.requireTask(taskId);
    if (task.status !== "running" && task.status !== "paused") {
      throw new InvalidTaskStateError(
        taskId,
        `cannot request human takeover from status "${task.status}"`,
      );
    }
    this.store.setStatus(taskId, "awaiting_human");
    this.controllers.get(taskId)?.abort();
    return this.requireTask(taskId);
  }

  /** Re-queue a failed task; increments the attempt counter on the next run. */
  retry(taskId: TaskId): AgentTask {
    const task = this.requireTask(taskId);
    if (task.status !== "failed") {
      throw new InvalidTaskStateError(taskId, `cannot retry from status "${task.status}"`);
    }
    const retried: AgentTask = {
      ...task,
      status: "ready",
      updatedAt: this.clock().toISOString(),
    };
    delete retried.error;
    delete retried.result;
    this.store.put(retried);
    return this.requireTask(taskId);
  }

  /** Reassign a task to a different agent and/or kind. Not allowed while running. */
  reassign(taskId: TaskId, target: { agentId?: AgentId; kind?: TaskKind }): AgentTask {
    const task = this.requireTask(taskId);
    if (task.status === "running") {
      throw new InvalidTaskStateError(taskId, "cannot reassign a running task");
    }
    const meta = this.metaFor(taskId);
    const updated: AgentTask = {
      ...task,
      assignedAgentId: target.agentId ?? task.assignedAgentId,
      updatedAt: this.clock().toISOString(),
    };
    if (target.kind !== undefined) meta.kind = target.kind;
    this.store.put(updated);
    return this.requireTask(taskId);
  }

  // ------------------------------------------------------------- detection

  /**
   * Mark running tasks whose last progress heartbeat is older than the zombie
   * TTL as failed. Run on daemon start for crash recovery and periodically.
   * Returns the swept task ids.
   */
  sweep(now: Date = this.clock()): TaskId[] {
    const swept: TaskId[] = [];
    for (const task of this.store.listByWorkspace(this.workspaceId, "running")) {
      const heartbeat = this.metaFor(task.id).lastProgressAt ?? task.updatedAt;
      if (now.getTime() - Date.parse(heartbeat) > this.zombieTtlMs) {
        this.store.fail(
          task.id,
          `zombie: no progress heartbeat since ${heartbeat} (ttl ${this.zombieTtlMs}ms)`,
        );
        this.controllers.get(task.id)?.abort();
        swept.push(task.id);
      }
    }
    return swept;
  }

  // --------------------------------------------------------------- results

  /**
   * Aggregate a root task and all of its descendants in dependency order
   * (dependencies before dependents) for merging into the parent.
   */
  collectResults(rootTaskId: TaskId): CollectedTaskResult[] {
    const root = this.store.get(rootTaskId);
    if (root === undefined) throw new TaskNotFoundError(rootTaskId);

    const members = new Map<TaskId, AgentTask>();
    const queue: TaskId[] = [root.id];
    members.set(root.id, root);
    const all = this.store.listByWorkspace(root.workspaceId);
    while (queue.length > 0) {
      const id = queue.shift();
      if (id === undefined) break;
      for (const child of all) {
        if (child.parentTaskId === id && !members.has(child.id)) {
          members.set(child.id, child);
          queue.push(child.id);
        }
      }
    }

    // Kahn over the subtree: dependencies before dependents.
    const indegree = new Map<TaskId, number>();
    const dependents = new Map<TaskId, TaskId[]>();
    for (const t of members.values()) {
      const deps = t.dependencies.filter((d) => members.has(d));
      indegree.set(t.id, deps.length);
      for (const d of deps) {
        const list = dependents.get(d) ?? [];
        list.push(t.id);
        dependents.set(d, list);
      }
    }
    const readyQueue = [...members.values()]
      .filter((t) => (indegree.get(t.id) ?? 0) === 0)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map((t) => t.id);
    const ordered: AgentTask[] = [];
    while (readyQueue.length > 0) {
      const id = readyQueue.shift();
      if (id === undefined) break;
      const task = members.get(id);
      if (task !== undefined) ordered.push(task);
      for (const next of dependents.get(id) ?? []) {
        const deg = (indegree.get(next) ?? 0) - 1;
        indegree.set(next, deg);
        if (deg === 0) readyQueue.push(next);
      }
    }

    return ordered.map((t) => {
      const entry: CollectedTaskResult = {
        taskId: t.id,
        parentTaskId: t.parentTaskId,
        kind: this.metaFor(t.id).kind,
        objective: t.objective,
        status: t.status,
        dependencies: t.dependencies,
      };
      if (t.result !== undefined) {
        return { ...entry, result: t.result };
      }
      if (t.error !== undefined) {
        return { ...entry, error: t.error };
      }
      return entry;
    });
  }

  // -------------------------------------------------------------- inspect

  getTask(taskId: TaskId): AgentTask {
    return this.requireTask(taskId);
  }

  taskKind(taskId: TaskId): TaskKind {
    return this.metaFor(taskId).kind;
  }

  attempts(taskId: TaskId): number {
    return this.metaFor(taskId).attempts;
  }

  progressLog(taskId: TaskId): readonly TaskRunRecord[] {
    return this.metaFor(taskId).progress;
  }

  /** Effective tool scope: nearest non-null allowedTools up the parent chain. */
  effectiveTools(task: AgentTask): string[] | null {
    let current: AgentTask | undefined = task;
    while (current !== undefined) {
      if (current.allowedTools !== null) return current.allowedTools;
      if (current.parentTaskId === null) return null;
      current = this.store.get(current.parentTaskId);
    }
    return null;
  }

  // -------------------------------------------------------------- internal

  private requireTask(taskId: TaskId): AgentTask {
    const task = this.store.get(taskId);
    if (task === undefined) throw new TaskNotFoundError(taskId);
    return task;
  }

  private metaFor(taskId: TaskId): TaskMeta {
    let meta = this.meta.get(taskId);
    if (meta === undefined) {
      meta = {
        kind: "execute",
        sessionId: null,
        attempts: 0,
        lastProgressAt: null,
        progress: [],
        detector: null,
      };
      this.meta.set(taskId, meta);
    }
    return meta;
  }

  private assertAcyclic(newId: TaskId, dependencies: readonly TaskId[]): void {
    const stack: TaskId[] = [...dependencies];
    const visited = new Set<TaskId>();
    while (stack.length > 0) {
      const id = stack.pop();
      if (id === undefined) break;
      if (id === newId) {
        throw new CyclicDependencyError(newId, [newId, ...dependencies]);
      }
      if (visited.has(id)) continue;
      visited.add(id);
      const task = this.store.get(id);
      if (task !== undefined) stack.push(...task.dependencies);
    }
  }

  private budgetViolation(task: AgentTask): BudgetViolation | null {
    const { budget, consumed } = task;
    if (budget.maxTokens !== undefined && consumed.tokens > budget.maxTokens) {
      return { dimension: "tokens", limit: budget.maxTokens, consumed: consumed.tokens };
    }
    if (budget.maxCostUsd !== undefined && consumed.costUsd > budget.maxCostUsd) {
      return { dimension: "costUsd", limit: budget.maxCostUsd, consumed: consumed.costUsd };
    }
    if (budget.maxToolCalls !== undefined && consumed.toolCalls > budget.maxToolCalls) {
      return {
        dimension: "toolCalls",
        limit: budget.maxToolCalls,
        consumed: consumed.toolCalls,
      };
    }
    if (budget.maxDurationMs !== undefined && consumed.durationMs > budget.maxDurationMs) {
      return {
        dimension: "durationMs",
        limit: budget.maxDurationMs,
        consumed: consumed.durationMs,
      };
    }
    return null;
  }

  /** Fail a running task and abort its runner. */
  private trip(taskId: TaskId, reason: string): void {
    const task = this.store.get(taskId);
    if (task !== undefined && task.status === "running") {
      this.store.fail(taskId, reason);
    }
    this.controllers.get(taskId)?.abort();
  }

  private handleProgress(taskId: TaskId, event: TaskProgressEvent): void {
    const meta = this.metaFor(taskId);
    const now = this.clock().toISOString();
    meta.lastProgressAt = now;
    meta.progress.push({ taskId, at: now, event });

    if (event.type === "usage") {
      try {
        this.recordUsage(taskId, event);
      } catch (err) {
        if (!(err instanceof BudgetExceededError)) throw err;
        // Budget trip already failed + aborted the task; the runner sees the signal.
      }
    }

    if (event.type === "tool_call" && meta.detector !== null) {
      const reason = meta.detector.observe(event.signature);
      if (reason !== null) this.trip(taskId, reason);
    }

    const started = this.startedAt.get(taskId);
    const task = this.store.get(taskId);
    if (
      started !== undefined &&
      task !== undefined &&
      task.status === "running" &&
      task.budget.maxDurationMs !== undefined
    ) {
      const elapsed = Date.parse(now) - Date.parse(started);
      if (elapsed > task.budget.maxDurationMs) {
        this.trip(
          taskId,
          budgetMessage({
            dimension: "durationMs",
            limit: task.budget.maxDurationMs,
            consumed: task.consumed.durationMs + elapsed,
          }),
        );
      }
    }
  }

  /** Promote blocked tasks whose dependencies are all completed. */
  private refreshReady(workspaceId: WorkspaceId): void {
    for (const task of this.store.listByWorkspace(workspaceId, "blocked")) {
      const satisfied = task.dependencies.every((depId) => {
        const dep = this.store.get(depId);
        return dep !== undefined && dep.status === "completed";
      });
      if (satisfied) this.store.setStatus(task.id, "ready");
    }
  }
}

function budgetMessage(violation: BudgetViolation): string {
  return (
    `budget exceeded: ${violation.dimension} ` +
    `${violation.consumed} > ${violation.limit}`
  );
}
