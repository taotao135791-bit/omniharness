import type { DatabaseSync } from "node:sqlite";
import type {
  AgentId,
  AgentTask,
  IsoTimestamp,
  TaskId,
  TaskStatus,
  WorkspaceId,
  WorktreeId,
} from "@omniharness/shared-types";
import { nowIso } from "@omniharness/shared-types";
import { allRows, getRow, jparse, jstr } from "../helpers.js";

interface TaskRow {
  id: string;
  parent_task_id: string | null;
  objective: string;
  status: string;
  assigned_agent_id: string | null;
  workspace_id: string;
  worktree_id: string | null;
  allowed_tools: string | null;
  budget: string;
  checkpoints: string;
  artifacts: string;
  result: string | null;
  error: string | null;
  consumed: string;
  created_at: string;
  updated_at: string;
}

export class TasksRepo {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  private rowToTask(r: TaskRow): AgentTask {
    const task: AgentTask = {
      id: r.id as TaskId,
      parentTaskId: r.parent_task_id as TaskId | null,
      objective: r.objective,
      status: r.status as TaskStatus,
      dependencies: this.getDependencies(r.id as TaskId),
      assignedAgentId: r.assigned_agent_id as AgentId | null,
      workspaceId: r.workspace_id as WorkspaceId,
      worktreeId: r.worktree_id as WorktreeId | null,
      allowedTools: r.allowed_tools === null ? null : jparse<string[]>(r.allowed_tools, []),
      budget: jparse<AgentTask["budget"]>(r.budget, {}),
      checkpoints: jparse<AgentTask["checkpoints"]>(r.checkpoints, []),
      artifacts: jparse<AgentTask["artifacts"]>(r.artifacts, []),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      consumed: jparse<AgentTask["consumed"]>(r.consumed, {
        tokens: 0,
        costUsd: 0,
        toolCalls: 0,
        durationMs: 0,
      }),
    };
    if (r.result !== null) task.result = r.result;
    if (r.error !== null) task.error = r.error;
    return task;
  }

  /** Upsert a task and fully replace its dependency edge set. */
  put(task: AgentTask): void {
    this.db
      .prepare(
        `INSERT INTO tasks
           (id, parent_task_id, objective, status, assigned_agent_id, workspace_id, worktree_id,
            allowed_tools, budget, checkpoints, artifacts, result, error, consumed, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           parent_task_id = excluded.parent_task_id, objective = excluded.objective,
           status = excluded.status, assigned_agent_id = excluded.assigned_agent_id,
           worktree_id = excluded.worktree_id, allowed_tools = excluded.allowed_tools,
           budget = excluded.budget, checkpoints = excluded.checkpoints,
           artifacts = excluded.artifacts, result = excluded.result, error = excluded.error,
           consumed = excluded.consumed, updated_at = excluded.updated_at`,
      )
      .run(
        task.id,
        task.parentTaskId,
        task.objective,
        task.status,
        task.assignedAgentId,
        task.workspaceId,
        task.worktreeId,
        task.allowedTools === null ? null : jstr(task.allowedTools),
        jstr(task.budget),
        jstr(task.checkpoints),
        jstr(task.artifacts),
        task.result ?? null,
        task.error ?? null,
        jstr(task.consumed),
        task.createdAt,
        task.updatedAt,
      );
    this.db.prepare("DELETE FROM task_dependencies WHERE task_id = ?").run(task.id);
    const dep = this.db.prepare(
      "INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)",
    );
    for (const depId of task.dependencies) dep.run(task.id, depId);
  }

  get(id: TaskId): AgentTask | undefined {
    const row = getRow<TaskRow>(this.db.prepare("SELECT * FROM tasks WHERE id = ?"), id);
    return row === undefined ? undefined : this.rowToTask(row);
  }

  listByWorkspace(workspaceId: WorkspaceId, status?: TaskStatus): AgentTask[] {
    const rows =
      status === undefined
        ? allRows<TaskRow>(
            this.db.prepare("SELECT * FROM tasks WHERE workspace_id = ? ORDER BY created_at, id"),
            workspaceId,
          )
        : allRows<TaskRow>(
            this.db.prepare(
              "SELECT * FROM tasks WHERE workspace_id = ? AND status = ? ORDER BY created_at, id",
            ),
            workspaceId,
            status,
          );
    return rows.map((r) => this.rowToTask(r));
  }

  /** Tasks that directly depend on `id`. */
  listDependents(id: TaskId): AgentTask[] {
    return allRows<TaskRow>(
      this.db.prepare(
        `SELECT t.* FROM tasks t
         JOIN task_dependencies d ON d.task_id = t.id
         WHERE d.depends_on_task_id = ? ORDER BY t.created_at, t.id`,
      ),
      id,
    ).map((r) => this.rowToTask(r));
  }

  getDependencies(id: TaskId): TaskId[] {
    return allRows<{ depends_on_task_id: string }>(
      this.db.prepare(
        "SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ? ORDER BY depends_on_task_id",
      ),
      id,
    ).map((r) => r.depends_on_task_id as TaskId);
  }

  setStatus(id: TaskId, status: TaskStatus): boolean {
    return (
      this.db
        .prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?")
        .run(status, nowIso(), id).changes > 0
    );
  }

  complete(id: TaskId, result: string, at: IsoTimestamp = nowIso()): boolean {
    return (
      this.db
        .prepare("UPDATE tasks SET status = 'completed', result = ?, updated_at = ? WHERE id = ?")
        .run(result, at, id).changes > 0
    );
  }

  fail(id: TaskId, error: string, at: IsoTimestamp = nowIso()): boolean {
    return (
      this.db
        .prepare("UPDATE tasks SET status = 'failed', error = ?, updated_at = ? WHERE id = ?")
        .run(error, at, id).changes > 0
    );
  }

  delete(id: TaskId): boolean {
    return this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id).changes > 0;
  }
}
