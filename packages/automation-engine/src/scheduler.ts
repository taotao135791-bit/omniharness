import { randomUUID } from "node:crypto";
import type {
  Automation,
  AutomationId,
  AutomationRun,
  AutomationRunId,
  SessionId,
} from "@omniharness/shared-types";
import { AutomationNotFoundError, type AutomationEngine } from "./engine.js";

/** Outcome of one automation execution, as reported by the daemon. */
export type AutomationRunOutcome =
  | { sessionId: SessionId; resultSummary: string }
  | { error: string };

export interface RunContext {
  /** 1-based attempt number; retries increment it. */
  attempt: number;
  reason: "schedule" | "manual" | "file_change";
}

/**
 * Implemented by the daemon: runs the automation's prompt in a fresh isolated
 * session, constrained to effectivePermissions(automation) and its budget.
 */
export interface AutomationRunner {
  run(automation: Automation, context: RunContext): Promise<AutomationRunOutcome>;
}

export class AutomationTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`timeout after ${timeoutMs}ms`);
    this.name = "AutomationTimeoutError";
  }
}

export interface SchedulerOptions {
  engine: AutomationEngine;
  runner: AutomationRunner;
  now?: () => Date;
  /** Tick cadence for start(); default 30s. tick() can also be called directly. */
  tickIntervalMs?: number;
  /** Max simultaneous automation runs; the rest queue. Default 4. */
  maxConcurrentRuns?: number;
  /** Delay before retry attempt N (1-based, N >= 2). Default: 1s * 2^(N-2). */
  retryBackoffMs?: (nextAttempt: number) => number;
}

const defaultBackoff = (nextAttempt: number): number => 1000 * 2 ** (nextAttempt - 2);

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Drives automations: a tick loop finds due automations (nextRunAt <= now),
 * coalesces missed runs (a past-due automation runs exactly once, never N
 * times), executes them through the injected runner under a concurrency cap,
 * enforces per-run timeouts, retries per the onFailure policy with backoff,
 * and records every attempt as an AutomationRun.
 *
 * Uses global timers so tests can drive it with vi.useFakeTimers().
 */
export class Scheduler {
  private readonly engine: AutomationEngine;
  private readonly runner: AutomationRunner;
  private readonly now: () => Date;
  private readonly tickIntervalMs: number;
  private readonly maxConcurrentRuns: number;
  private readonly retryBackoffMs: (nextAttempt: number) => number;

  private interval: ReturnType<typeof setInterval> | null = null;
  private readonly retryTimers = new Set<ReturnType<typeof setTimeout>>();
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(options: SchedulerOptions) {
    this.engine = options.engine;
    this.runner = options.runner;
    this.now = options.now ?? (() => new Date());
    this.tickIntervalMs = options.tickIntervalMs ?? 30_000;
    this.maxConcurrentRuns = options.maxConcurrentRuns ?? 4;
    this.retryBackoffMs = options.retryBackoffMs ?? defaultBackoff;
  }

  start(): void {
    if (this.interval !== null) return;
    this.interval = setInterval(() => this.tick(), this.tickIntervalMs);
    this.tick();
  }

  stop(): void {
    if (this.interval !== null) {
      clearInterval(this.interval);
      this.interval = null;
    }
    for (const t of this.retryTimers) clearTimeout(t);
    this.retryTimers.clear();
  }

  /**
   * One scheduler pass: fire every due automation once. Reschedules
   * nextRunAt before launching so a run slower than the tick can't double-fire
   * (this is also what makes catch-up after downtime coalesce to one run).
   */
  tick(): void {
    const now = this.now();
    const nowIso = now.toISOString();
    for (const automation of this.engine.listDue(nowIso)) {
      const next = this.engine.computeNextRunAt(automation, now);
      this.engine.markRun(automation.id, nowIso, next);
      void this.launch({ ...automation, lastRunAt: nowIso, nextRunAt: next }, {
        attempt: 1,
        reason: "schedule",
      });
    }
  }

  /** Manual trigger: runs even when the automation is disabled. */
  runNow(id: AutomationId): Promise<AutomationRun> {
    const automation = this.engine.get(id);
    if (automation === undefined) return Promise.reject(new AutomationNotFoundError(id));
    return this.launch(automation, { attempt: 1, reason: "manual" });
  }

  /** File-watch trigger: fires only when the automation is enabled. */
  notifyFileChange(id: AutomationId): Promise<AutomationRun> | null {
    const automation = this.engine.get(id);
    if (automation === undefined || !automation.enabled) return null;
    return this.launch(automation, { attempt: 1, reason: "file_change" });
  }

  private launch(automation: Automation, context: RunContext): Promise<AutomationRun> {
    if (this.active < this.maxConcurrentRuns) {
      this.active += 1;
      return this.execute(automation, context).finally(() => {
        this.active -= 1;
        const next = this.queue.shift();
        if (next !== undefined) next();
      });
    }
    return new Promise<AutomationRun>((resolve) => {
      this.queue.push(() => {
        resolve(this.launch(automation, context));
      });
    });
  }

  private async execute(automation: Automation, context: RunContext): Promise<AutomationRun> {
    const run: AutomationRun = {
      id: `arun_${randomUUID()}` as AutomationRunId,
      automationId: automation.id,
      status: "running",
      sessionId: null,
      startedAt: this.now().toISOString(),
      endedAt: null,
      attempt: context.attempt,
    };
    this.engine.recordRun(run);
    try {
      const outcome = await this.withTimeout(
        this.runner.run(automation, context),
        automation.timeoutMs,
      );
      if ("error" in outcome) {
        run.status = "failed";
        run.error = outcome.error;
      } else {
        run.status = "completed";
        run.sessionId = outcome.sessionId;
        run.resultSummary = outcome.resultSummary;
      }
    } catch (err) {
      run.status = "failed";
      run.error = errorMessage(err);
    }
    run.endedAt = this.now().toISOString();
    this.engine.recordRun(run);

    if (
      run.status === "failed" &&
      automation.onFailure === "retry" &&
      context.attempt <= automation.maxRetries
    ) {
      const timer = setTimeout(() => {
        this.retryTimers.delete(timer);
        void this.launch(automation, { attempt: context.attempt + 1, reason: context.reason });
      }, this.retryBackoffMs(context.attempt + 1));
      this.retryTimers.add(timer);
    }
    return run;
  }

  /** Runner keeps running in the background on timeout; the run is failed. */
  private withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new AutomationTimeoutError(timeoutMs)), timeoutMs);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err: unknown) => {
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(errorMessage(err)));
        },
      );
    });
  }
}
