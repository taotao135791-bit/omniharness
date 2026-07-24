import { beforeEach, describe, expect, it } from "vitest";
import type {
  AgentId,
  AgentTask,
  TaskId,
  WorkspaceId,
  WorktreeId,
} from "@omniharness/shared-types";
import { openDatabase, type OmniDatabase } from "@omniharness/session-store";
import {
  BudgetExceededError,
  CyclicDependencyError,
  PermissionWideningError,
  TaskNotFoundError,
  TaskOrchestrator,
} from "./index.js";
import type {
  TaskRunOutcome,
  TaskRunner,
  TaskRunnerContext,
  WorktreeAllocation,
} from "./index.js";

const WS = "ws_test" as WorkspaceId;

type Handler = (task: AgentTask, ctx: TaskRunnerContext) => Promise<TaskRunOutcome>;

class ScriptedRunner implements TaskRunner {
  readonly handlers = new Map<string, Handler>();
  readonly executed: string[] = [];
  fallback: Handler = (task) => Promise.resolve({ result: `done:${task.objective}` });

  run(task: AgentTask, ctx: TaskRunnerContext): Promise<TaskRunOutcome> {
    this.executed.push(task.objective);
    const handler = this.handlers.get(task.objective) ?? this.fallback;
    return handler(task, ctx);
  }
}

class FakeWorktreeAllocator {
  readonly acquired: Array<{ workspaceId: WorkspaceId; taskId: TaskId }> = [];
  readonly released: WorktreeId[] = [];
  private n = 0;

  acquire(workspaceId: WorkspaceId, taskId: TaskId): Promise<WorktreeAllocation> {
    this.acquired.push({ workspaceId, taskId });
    this.n += 1;
    return Promise.resolve({
      worktreeId: `wt_${this.n}` as WorktreeId,
      path: `/tmp/wt_${this.n}`,
    });
  }

  release(worktreeId: WorktreeId): void {
    this.released.push(worktreeId);
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

let db: OmniDatabase;
let runner: ScriptedRunner;
let orch: TaskOrchestrator;
let idCounter: number;
const nextId = (): TaskId => `task_${idCounter + 1}` as TaskId;

beforeEach(() => {
  db = openDatabase(":memory:");
  runner = new ScriptedRunner();
  idCounter = 0;
  orch = new TaskOrchestrator({
    store: db.tasks,
    workspaceId: WS,
    runner,
    idGenerator: () => `task_${++idCounter}` as TaskId,
  });
});

describe("create + dependencies", () => {
  it("creates a ready task and blocks dependents until deps complete", async () => {
    const a = orch.createTask({ objective: "A" });
    const b = orch.createTask({ objective: "B", dependencies: [a.id] });
    expect(a.status).toBe("ready");
    expect(b.status).toBe("blocked");
    expect(orch.readyTasks().map((t) => t.id)).toEqual([a.id]);

    await orch.run(a.id);
    expect(orch.getTask(b.id).status).toBe("ready");
    expect(orch.readyTasks().map((t) => t.id)).toEqual([b.id]);
  });

  it("rejects unknown dependencies", () => {
    expect(() =>
      orch.createTask({ objective: "X", dependencies: ["task_999" as TaskId] }),
    ).toThrow(TaskNotFoundError);
  });

  it("rejects dependency cycles", () => {
    orch.createTask({ objective: "A" });
    expect(() =>
      orch.createTask({ objective: "self", dependencies: [nextId()] }),
    ).toThrow(CyclicDependencyError);
  });
});

describe("permission subset invariant", () => {
  it("allows narrowing, rejects widening", () => {
    const parent = orch.createTask({
      objective: "parent",
      allowedTools: ["fs.read", "fs.write"],
    });
    const child = orch.createTask({
      objective: "child",
      parentTaskId: parent.id,
      allowedTools: ["fs.read"],
    });
    expect(child.allowedTools).toEqual(["fs.read"]);

    expect(() =>
      orch.createTask({
        objective: "evil",
        parentTaskId: parent.id,
        allowedTools: ["fs.read", "shell.exec"],
      }),
    ).toThrow(PermissionWideningError);
  });

  it("null inherits the parent's effective scope transitively", () => {
    const parent = orch.createTask({
      objective: "parent",
      allowedTools: ["fs.read"],
    });
    const child = orch.createTask({ objective: "child", parentTaskId: parent.id });
    expect(child.allowedTools).toBeNull();
    expect(orch.effectiveTools(orch.getTask(child.id))).toEqual(["fs.read"]);

    expect(() =>
      orch.createTask({
        objective: "grandchild",
        parentTaskId: child.id,
        allowedTools: ["fs.read", "net.fetch"],
      }),
    ).toThrow(PermissionWideningError);
  });

  it("unconstrained parent allows any child scope", () => {
    const parent = orch.createTask({ objective: "root" });
    const child = orch.createTask({
      objective: "child",
      parentTaskId: parent.id,
      allowedTools: ["anything"],
    });
    expect(child.allowedTools).toEqual(["anything"]);
  });
});

describe("scheduling", () => {
  it("runs a dependency chain in topological order", async () => {
    const a = orch.createTask({ objective: "A" });
    const b = orch.createTask({ objective: "B", dependencies: [a.id] });
    orch.createTask({ objective: "C", dependencies: [b.id] });

    const results = await orch.runReady();
    expect(results.every((t) => t.status === "completed")).toBe(true);
    expect(runner.executed).toEqual(["A", "B", "C"]);
  });

  it("runs independent tasks in parallel under a concurrency limit", async () => {
    let active = 0;
    let maxActive = 0;
    runner.fallback = async (task) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await sleep(20);
      active -= 1;
      return { result: `done:${task.objective}` };
    };
    for (const name of ["t1", "t2", "t3", "t4", "t5"]) {
      orch.createTask({ objective: name });
    }

    const results = await orch.runReady({ concurrency: 2 });
    expect(results).toHaveLength(5);
    expect(results.every((t) => t.status === "completed")).toBe(true);
    expect(maxActive).toBe(2);
  });

  it("acquires and releases a worktree around the run", async () => {
    const allocator = new FakeWorktreeAllocator();
    orch = new TaskOrchestrator({
      store: db.tasks,
      workspaceId: WS,
      runner,
      worktreeAllocator: allocator,
      idGenerator: () => `task_${++idCounter}` as TaskId,
    });
    const task = orch.createTask({ objective: "wt" });
    const final = await orch.run(task.id);
    expect(allocator.acquired).toEqual([{ workspaceId: WS, taskId: task.id }]);
    expect(allocator.released).toEqual(["wt_1" as WorktreeId]);
    expect(final.worktreeId).toBe("wt_1" as WorktreeId);
    expect(final.status).toBe("completed");
  });
});

describe("budgets", () => {
  it("stops a running task when its budget is exceeded", async () => {
    const task = orch.createTask({
      objective: "spendy",
      budget: { maxTokens: 10 },
    });
    let sawAbort = false;
    runner.handlers.set("spendy", (t, ctx) => {
      orch.recordUsage(t.id, { tokens: 6 });
      expect(() => orch.recordUsage(t.id, { tokens: 6 })).toThrow(BudgetExceededError);
      sawAbort = ctx.signal.aborted;
      return Promise.resolve({ result: "too late" });
    });

    const final = await orch.run(task.id);
    expect(sawAbort).toBe(true);
    expect(final.status).toBe("failed");
    expect(final.error).toContain("budget exceeded: tokens");
    expect(final.consumed.tokens).toBe(12);
  });

  it("refuses to start a task whose budget is already exhausted", async () => {
    const task = orch.createTask({
      objective: "pre-spent",
      budget: { maxToolCalls: 1 },
    });
    expect(() => orch.recordUsage(task.id, { toolCalls: 2 })).toThrow(
      BudgetExceededError,
    );
    await expect(orch.run(task.id)).rejects.toThrow(BudgetExceededError);
    expect(orch.getTask(task.id).status).toBe("failed");
    expect(runner.executed).toEqual([]);
  });

  it("accounts usage reported through progress events", async () => {
    const task = orch.createTask({
      objective: "metered",
      budget: { maxCostUsd: 1 },
    });
    runner.handlers.set("metered", (_t, ctx) => {
      ctx.onProgress({ type: "usage", costUsd: 2 });
      return Promise.resolve({ result: "x" });
    });
    const final = await orch.run(task.id);
    expect(final.status).toBe("failed");
    expect(final.consumed.costUsd).toBe(2);
  });
});

describe("lifecycle", () => {
  it("retries a failed task with an attempt counter", async () => {
    let calls = 0;
    runner.handlers.set("flaky", () => {
      calls += 1;
      return Promise.resolve(
        calls === 1 ? { error: "boom" } : { result: "ok" },
      );
    });
    const task = orch.createTask({ objective: "flaky" });

    const first = await orch.run(task.id);
    expect(first.status).toBe("failed");
    expect(first.error).toBe("boom");
    expect(orch.attempts(task.id)).toBe(1);

    const retried = orch.retry(task.id);
    expect(retried.status).toBe("ready");
    expect(retried.error).toBeUndefined();

    const second = await orch.run(task.id);
    expect(second.status).toBe("completed");
    expect(second.result).toBe("ok");
    expect(orch.attempts(task.id)).toBe(2);
  });

  it("pauses, hands to human, resumes and cancels", async () => {
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    runner.handlers.set("long", (_t, ctx) => {
      started();
      return new Promise<TaskRunOutcome>((resolve) => {
        ctx.signal.addEventListener("abort", () => resolve({ error: "aborted" }));
      });
    });
    const task = orch.createTask({ objective: "long" });
    const running = orch.run(task.id);
    await startedPromise;
    expect(orch.getTask(task.id).status).toBe("running");

    expect(orch.pause(task.id).status).toBe("paused");
    await running; // runner settled on abort; status stays paused
    expect(orch.getTask(task.id).status).toBe("paused");

    expect(orch.handToHuman(task.id).status).toBe("awaiting_human");
    expect(orch.resume(task.id).status).toBe("ready");
    expect(orch.cancel(task.id).status).toBe("cancelled");
  });

  it("reassigns agent and kind when not running", () => {
    const task = orch.createTask({ objective: "job" });
    const updated = orch.reassign(task.id, { agentId: "agent_42" as AgentId });
    expect(updated.assignedAgentId).toBe("agent_42");
    orch.reassign(task.id, { kind: "critic" });
    expect(orch.taskKind(task.id)).toBe("critic");
  });
});

describe("detection", () => {
  it("sweeps zombie tasks with stale heartbeats", () => {
    const task = orch.createTask({ objective: "crashed" });
    const stale = "2026-01-01T00:00:00.000Z";
    db.tasks.put({ ...orch.getTask(task.id), status: "running", updatedAt: stale });

    const swept = orch.sweep(new Date("2026-01-01T00:05:00.000Z"));
    expect(swept).toEqual([task.id]);
    const final = orch.getTask(task.id);
    expect(final.status).toBe("failed");
    expect(final.error).toContain("zombie");

    // fresh heartbeat survives the sweep
    const alive = orch.createTask({ objective: "alive" });
    const now = "2026-01-01T00:05:00.000Z";
    db.tasks.put({ ...orch.getTask(alive.id), status: "running", updatedAt: now });
    expect(orch.sweep(new Date("2026-01-01T00:05:30.000Z"))).toEqual([]);
  });

  it("trips the dead-loop detector on repeated identical tool calls", async () => {
    let sawAbort = false;
    runner.handlers.set("loopy", (_t, ctx) => {
      for (let i = 0; i < 5; i += 1) {
        ctx.onProgress({ type: "tool_call", signature: "bash(ls -la)" });
      }
      sawAbort = ctx.signal.aborted;
      return Promise.resolve({ result: "x" });
    });
    const task = orch.createTask({ objective: "loopy" });
    const final = await orch.run(task.id);
    expect(sawAbort).toBe(true);
    expect(final.status).toBe("failed");
    expect(final.error).toContain("dead loop");
  });

  it("does not trip on varied tool calls", async () => {
    runner.handlers.set("varied", (_t, ctx) => {
      for (let i = 0; i < 8; i += 1) {
        ctx.onProgress({ type: "tool_call", signature: `bash(step ${i})` });
      }
      return Promise.resolve({ result: "fine" });
    });
    const task = orch.createTask({ objective: "varied" });
    const final = await orch.run(task.id);
    expect(final.status).toBe("completed");
    expect(orch.progressLog(task.id)).toHaveLength(8);
  });
});

describe("results + review chains", () => {
  it("collectResults aggregates the subtree in dependency order", () => {
    const root = orch.createTask({ objective: "root" });
    const c1 = orch.createTask({ objective: "c1", parentTaskId: root.id });
    const c2 = orch.createTask({
      objective: "c2",
      parentTaskId: root.id,
      dependencies: [c1.id],
    });
    orch.createTask({ objective: "unrelated" });
    db.tasks.complete(c1.id, "r1");
    db.tasks.complete(c2.id, "r2");
    db.tasks.complete(root.id, "root-result");

    const collected = orch.collectResults(root.id);
    expect(collected.map((r) => r.taskId)).toEqual([root.id, c1.id, c2.id]);
    expect(collected.map((r) => r.result)).toEqual(["root-result", "r1", "r2"]);
  });

  it("scheduleWithReview builds an execute → review chain", async () => {
    const { execute, review } = orch.scheduleWithReview("implement feature");
    expect(orch.taskKind(execute.id)).toBe("execute");
    expect(orch.taskKind(review.id)).toBe("review");
    expect(review.dependencies).toEqual([execute.id]);
    expect(review.status).toBe("blocked");

    await orch.runReady();
    expect(runner.executed).toEqual(["implement feature", "Review: implement feature"]);
    expect(orch.getTask(review.id).status).toBe("completed");
  });
});
