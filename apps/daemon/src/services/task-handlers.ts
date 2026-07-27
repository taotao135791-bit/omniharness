import type { DaemonContext } from "../context.js";
import type { RunService } from "./run-service.js";
import { TaskOrchestrator, type TaskRunner } from "@omniharness/agent-orchestrator";
import type { AgentTask, SessionId, TaskId } from "@omniharness/shared-types";
import { RpcError } from "../rpc-server.js";
import { ErrorCodes } from "@omniharness/agent-protocol";

type Register = (name: string, handler: (params: never) => unknown) => void;

/** Multi-agent task orchestration commands. */
export function registerTaskHandlers(
  register: Register,
  ctx: DaemonContext,
  runs: RunService,
): void {
  const { db, bus } = ctx;

  // taskId → sessionId (AgentTask has no sessionId column; the daemon tracks it).
  const taskSessions = new Map<string, SessionId>();

  // Tasks execute by starting a run in their own (tool-restricted) session.
  const runner: TaskRunner = {
    run: async (task, { signal, onProgress }) => {
      void signal;
      const sessionId = taskSessions.get(task.id) ?? null;
      if (!sessionId) return { error: "task has no session" };
      runs.setToolRestriction(sessionId, task.allowedTools);
      try {
        const { runId } = await runs.startRun({ sessionId, input: task.objective });
        return await new Promise((resolve) => {
          const off = bus.subscribe((event) => {
            if (event.type === "run.completed" && "runId" in event && event.runId === runId) {
              off();
              onProgress({ type: "heartbeat" });
              resolve({ result: "completed" });
            }
            if (event.type === "run.failed" && "runId" in event && event.runId === runId) {
              off();
              resolve({ error: event.error });
            }
          });
        });
      } finally {
        runs.setToolRestriction(sessionId, null);
      }
    },
  };

  // One orchestrator per workspace, created lazily.
  const orchestrators = new Map<string, TaskOrchestrator>();
  const orchestratorFor = (workspaceId: AgentTask["workspaceId"]): TaskOrchestrator => {
    let o = orchestrators.get(workspaceId);
    if (!o) {
      o = new TaskOrchestrator({ store: db.tasks, workspaceId, runner });
      orchestrators.set(workspaceId, o);
    }
    return o;
  };
  const orchestratorOfTask = (taskId: TaskId): TaskOrchestrator => {
    const task = db.tasks.get(taskId);
    if (!task) throw new RpcError(ErrorCodes.NOT_FOUND, `task not found: ${taskId}`);
    return orchestratorFor(task.workspaceId);
  };

  register(
    "task.create",
    async (params: {
      objective: string;
      sessionId: SessionId;
      parentTaskId?: TaskId;
      dependencies?: TaskId[];
      allowedTools?: string[];
      budget?: Record<string, number>;
    }) => {
      const session = db.sessions.get(params.sessionId);
      if (!session) throw new RpcError(ErrorCodes.NOT_FOUND, "session not found");
      const task = orchestratorFor(session.workspaceId).createTask({
        objective: params.objective,
        sessionId: params.sessionId,
        ...(params.parentTaskId ? { parentTaskId: params.parentTaskId } : {}),
        ...(params.dependencies ? { dependencies: params.dependencies } : {}),
        ...(params.allowedTools ? { allowedTools: params.allowedTools } : {}),
        ...(params.budget ? { budget: params.budget as AgentTask["budget"] } : {}),
      });
      taskSessions.set(task.id, params.sessionId);
      bus.emit({
        type: "task.created",
        taskId: task.id,
        parentTaskId: task.parentTaskId,
        objective: task.objective,
      });
      return { task };
    },
  );

  register("task.list", (params: { sessionId?: SessionId; status?: string }) => {
    let tasks: AgentTask[];
    if (params.sessionId) {
      const session = db.sessions.get(params.sessionId);
      if (!session) throw new RpcError(ErrorCodes.NOT_FOUND, "session not found");
      tasks = db.tasks
        .listByWorkspace(session.workspaceId)
        .filter((t) => taskSessions.get(t.id) === params.sessionId);
    } else {
      tasks = db.projects
        .list()
        .flatMap((p) =>
          db.workspaces.listByProject(p.id).flatMap((w) => db.tasks.listByWorkspace(w.id)),
        );
    }
    if (params.status) tasks = tasks.filter((t) => t.status === params.status);
    return { tasks };
  });

  register("task.pause", (params: { taskId: TaskId }) => {
    orchestratorOfTask(params.taskId).pause(params.taskId);
    bus.emit({ type: "task.status", taskId: params.taskId, status: "paused" });
    return { ok: true as const };
  });

  register("task.resume", (params: { taskId: TaskId }) => {
    orchestratorOfTask(params.taskId).resume(params.taskId);
    bus.emit({ type: "task.status", taskId: params.taskId, status: "ready" });
    return { ok: true as const };
  });

  register("task.cancel", (params: { taskId: TaskId }) => {
    orchestratorOfTask(params.taskId).cancel(params.taskId);
    bus.emit({ type: "task.status", taskId: params.taskId, status: "cancelled" });
    return { ok: true as const };
  });

  register("task.reassign", (params: { taskId: TaskId; agentKind: string }) => {
    orchestratorOfTask(params.taskId).reassign(params.taskId, { kind: params.agentKind as never });
    return { ok: true as const };
  });
}
