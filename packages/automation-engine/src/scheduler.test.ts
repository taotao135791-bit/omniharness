import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, type OmniDatabase } from "@omniharness/session-store";
import type { AutomationRun, ProfileId, SessionId, WorkspaceId } from "@omniharness/shared-types";
import { AutomationEngine } from "./engine.js";
import { Scheduler, type AutomationRunner, type AutomationRunOutcome } from "./scheduler.js";
import { makeInput, seedBase } from "./testkit.js";

const T0 = new Date("2024-03-01T09:00:00.000Z");
const SESSION_ID = "sess_run1" as SessionId;

let db: OmniDatabase;
let engine: AutomationEngine;
let ids: { profileId: ProfileId; workspaceId: WorkspaceId };

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  db = openDatabase(":memory:");
  ids = seedBase(db, T0.toISOString());
  engine = new AutomationEngine({ repo: db.automations });
});

afterEach(() => {
  db.close();
  vi.useRealTimers();
});

const okRunner = (calls: string[] = []): AutomationRunner => ({
  run: (automation) => {
    calls.push(automation.id);
    return Promise.resolve({ sessionId: SESSION_ID, resultSummary: "done" });
  },
});

function makeScheduler(runner: AutomationRunner, opts: Partial<ConstructorParameters<typeof Scheduler>[0]> = {}): Scheduler {
  return new Scheduler({ engine, runner, ...opts });
}

describe("Scheduler", () => {
  it("runs a due automation and records the run", async () => {
    const calls: string[] = [];
    const scheduler = makeScheduler(okRunner(calls));
    const a = engine.create(makeInput(ids, { trigger: { kind: "cron", expression: "0 10 * * *" } }));

    scheduler.tick(); // not due yet (09:00 < 10:00)
    expect(calls).toHaveLength(0);

    vi.setSystemTime(new Date("2024-03-01T10:00:01.000Z"));
    scheduler.tick();
    await vi.waitFor(() => expect(engine.listRuns(a.id, "completed")).toHaveLength(1));
    expect(calls).toHaveLength(1);
    const runs = engine.listRuns(a.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("completed");
    expect(runs[0]?.sessionId).toBe(SESSION_ID);
    expect(runs[0]?.resultSummary).toBe("done");
    expect(runs[0]?.attempt).toBe(1);
    // rescheduled into the future
    expect(engine.get(a.id)?.nextRunAt).toBe("2024-03-02T10:00:00.000Z");
    expect(engine.get(a.id)?.lastRunAt).toBe("2024-03-01T10:00:01.000Z");
    scheduler.stop();
  });

  it("coalesces missed runs after downtime to a single catch-up run", async () => {
    const calls: string[] = [];
    const scheduler = makeScheduler(okRunner(calls));
    const a = engine.create(makeInput(ids, { trigger: { kind: "cron", expression: "* * * * *" } }));
    expect(engine.get(a.id)?.nextRunAt).toBe("2024-03-01T09:01:00.000Z");

    // Simulate 10 minutes of downtime: 10 fire times pass with no tick.
    vi.setSystemTime(new Date("2024-03-01T09:10:00.000Z"));
    scheduler.tick();
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    scheduler.tick(); // immediately again: must not fire (nextRunAt is now in the future)
    await Promise.resolve();
    expect(calls).toHaveLength(1);
    expect(engine.get(a.id)?.nextRunAt).toBe("2024-03-01T09:11:00.000Z");
    expect(engine.listRuns(a.id)).toHaveLength(1);
    scheduler.stop();
  });

  it("retries on failure per onFailure policy with backoff", async () => {
    let attempt = 0;
    const runner: AutomationRunner = {
      run: () => {
        attempt += 1;
        return Promise.resolve<AutomationRunOutcome>(
          attempt === 1 ? { error: "boom" } : { sessionId: SESSION_ID, resultSummary: "recovered" },
        );
      },
    };
    const scheduler = makeScheduler(runner, { retryBackoffMs: () => 1000 });
    const a = engine.create(
      makeInput(ids, {
        trigger: { kind: "cron", expression: "0 10 * * *" },
        onFailure: "retry",
        maxRetries: 2,
      }),
    );

    vi.setSystemTime(new Date("2024-03-01T10:00:01.000Z"));
    scheduler.tick();
    await vi.waitFor(() => expect(engine.listRuns(a.id, "failed")).toHaveLength(1));
    expect(attempt).toBe(1);

    await vi.advanceTimersByTimeAsync(1000); // backoff fires retry
    await vi.waitFor(() =>
      expect(engine.listRuns(a.id).some((r) => r.attempt === 2 && r.status === "completed")).toBe(
        true,
      ),
    );
    expect(attempt).toBe(2);

    const runs = engine.listRuns(a.id);
    expect(runs).toHaveLength(2);
    const second = runs.find((r) => r.attempt === 2);
    expect(second?.resultSummary).toBe("recovered");
    scheduler.stop();
  });

  it("gives up after maxRetries", async () => {
    let attempt = 0;
    const runner: AutomationRunner = {
      run: () => {
        attempt += 1;
        return Promise.resolve<AutomationRunOutcome>({ error: `fail ${attempt}` });
      },
    };
    const scheduler = makeScheduler(runner, { retryBackoffMs: () => 500 });
    const a = engine.create(
      makeInput(ids, {
        trigger: { kind: "cron", expression: "0 10 * * *" },
        onFailure: "retry",
        maxRetries: 1, // one retry → attempts 1 and 2, then stop
      }),
    );

    vi.setSystemTime(new Date("2024-03-01T10:00:01.000Z"));
    scheduler.tick();
    await vi.waitFor(() => expect(attempt).toBe(1));
    await vi.advanceTimersByTimeAsync(500);
    await vi.waitFor(() => expect(attempt).toBe(2));
    await vi.advanceTimersByTimeAsync(10_000); // no further retries
    expect(attempt).toBe(2);
    expect(engine.listRuns(a.id, "failed")).toHaveLength(2);
    scheduler.stop();
  });

  it("does not retry when onFailure is notify", async () => {
    let attempt = 0;
    const runner: AutomationRunner = {
      run: () => {
        attempt += 1;
        return Promise.resolve<AutomationRunOutcome>({ error: "boom" });
      },
    };
    const scheduler = makeScheduler(runner, { retryBackoffMs: () => 100 });
    engine.create(
      makeInput(ids, { trigger: { kind: "cron", expression: "0 10 * * *" }, onFailure: "notify" }),
    );
    vi.setSystemTime(new Date("2024-03-01T10:00:01.000Z"));
    scheduler.tick();
    await vi.waitFor(() => expect(attempt).toBe(1));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(attempt).toBe(1);
    scheduler.stop();
  });

  it("respects maxConcurrentRuns and queues the rest", async () => {
    const started: string[] = [];
    const resolvers: Array<() => void> = [];
    const runner: AutomationRunner = {
      run: (automation) => {
        started.push(automation.id);
        return new Promise<AutomationRunOutcome>((resolve) => {
          resolvers.push(() => resolve({ sessionId: SESSION_ID, resultSummary: "ok" }));
        });
      },
    };
    const scheduler = makeScheduler(runner, { maxConcurrentRuns: 1 });
    const a1 = engine.create(makeInput(ids, { name: "a1", trigger: { kind: "cron", expression: "0 10 * * *" } }));
    const a2 = engine.create(makeInput(ids, { name: "a2", trigger: { kind: "cron", expression: "0 10 * * *" } }));

    vi.setSystemTime(new Date("2024-03-01T10:00:01.000Z"));
    scheduler.tick();
    await vi.waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]).toBe(a1.id); // listDue orders by nextRunAt, ties by creation order
    expect(started).not.toContain(a2.id);

    resolvers[0]?.();
    await vi.waitFor(() => expect(started).toHaveLength(2));
    expect(started[1]).toBe(a2.id);
    resolvers[1]?.();
    await vi.waitFor(() => expect(engine.listRuns(a2.id, "completed")).toHaveLength(1));
    scheduler.stop();
  });

  it("never fires a disabled automation, but runNow still works", async () => {
    const calls: string[] = [];
    const scheduler = makeScheduler(okRunner(calls));
    const a = engine.create(
      makeInput(ids, { enabled: false, trigger: { kind: "cron", expression: "* * * * *" } }),
    );

    vi.setSystemTime(new Date("2024-03-01T09:05:00.000Z"));
    scheduler.tick();
    await Promise.resolve();
    expect(calls).toHaveLength(0);

    const run = await scheduler.runNow(a.id);
    expect(calls).toHaveLength(1);
    expect(run.status).toBe("completed");
    expect(engine.listRuns(a.id)).toHaveLength(1);
    scheduler.stop();
  });

  it("marks a run failed when it exceeds timeoutMs", async () => {
    const runner: AutomationRunner = {
      run: () => new Promise<AutomationRunOutcome>(() => {}), // never settles
    };
    const scheduler = makeScheduler(runner);
    const a = engine.create(
      makeInput(ids, { trigger: { kind: "cron", expression: "0 10 * * *" }, timeoutMs: 1000 }),
    );

    vi.setSystemTime(new Date("2024-03-01T10:00:01.000Z"));
    scheduler.tick();
    await vi.waitFor(() => expect(engine.listRuns(a.id)).toHaveLength(1));
    expect(engine.listRuns(a.id)[0]?.status).toBe("running");

    await vi.advanceTimersByTimeAsync(1000);
    const runs: AutomationRun[] = engine.listRuns(a.id, "failed");
    expect(runs).toHaveLength(1);
    expect(runs[0]?.error).toBe("timeout after 1000ms");
    expect(runs[0]?.endedAt).not.toBeNull();
    scheduler.stop();
  });

  it("records runner-thrown errors as failed runs", async () => {
    const runner: AutomationRunner = {
      run: () => Promise.reject(new Error("session spawn failed")),
    };
    const scheduler = makeScheduler(runner);
    const a = engine.create(makeInput(ids, { trigger: { kind: "cron", expression: "0 10 * * *" } }));
    vi.setSystemTime(new Date("2024-03-01T10:00:01.000Z"));
    scheduler.tick();
    await vi.waitFor(() => expect(engine.listRuns(a.id, "failed")).toHaveLength(1));
    expect(engine.listRuns(a.id)[0]?.error).toBe("session spawn failed");
    scheduler.stop();
  });

  it("notifyFileChange runs enabled automations and skips disabled ones", async () => {
    const calls: string[] = [];
    const scheduler = makeScheduler(okRunner(calls));
    const on = engine.create(makeInput(ids, { trigger: { kind: "file_change", pathGlob: "/repo/**" } }));
    const off = engine.create(
      makeInput(ids, { enabled: false, trigger: { kind: "file_change", pathGlob: "/repo/**" } }),
    );

    const run = scheduler.notifyFileChange(on.id);
    expect(run).not.toBeNull();
    await run;
    expect(calls).toEqual([on.id]);

    expect(scheduler.notifyFileChange(off.id)).toBeNull();
    expect(calls).toHaveLength(1);
    scheduler.stop();
  });

  it("start() ticks on the interval and stop() halts it", async () => {
    const calls: string[] = [];
    const scheduler = makeScheduler(okRunner(calls), { tickIntervalMs: 30_000 });
    engine.create(makeInput(ids, { trigger: { kind: "cron", expression: "* * * * *" } }));

    scheduler.start(); // immediate tick: not due yet (due at 09:01)
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(30_000); // 09:00:30 — still not due
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(30_000); // 09:01:00 — due
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    scheduler.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls).toHaveLength(1);
  });
});
