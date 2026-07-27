import { nowIso } from "@omniharness/shared-types";
import { geometryMatches } from "./coordinates.js";
import type { InputDriver } from "./driver.js";
import { assertNoSecretLeak, type SecretResolver } from "./secure-fill.js";
import { classifyAction, type SensitiveAssessment } from "./sensitive.js";
import type {
  ActionResult,
  ComputerAction,
  ComputerContext,
  Observation,
  ScreenFrame,
  TraceEntry,
  VerificationResult,
} from "./types.js";

/** Model side of the loop: looks at the screen and proposes what to do next. */
export interface VisionProposer {
  propose(context: ComputerContext): Promise<ComputerAction[]>;
  verify?(
    action: ComputerAction,
    result: ActionResult,
    observation: Observation,
  ): Promise<VerificationResult>;
}

export interface ApprovalRequestInfo {
  action: ComputerAction;
  classification: SensitiveAssessment;
  summary: string;
  step: number;
}

/** Human (or policy) gate consulted before any sensitive action executes. */
export interface ApprovalGate {
  requestApproval(info: ApprovalRequestInfo): Promise<boolean>;
}

export interface ComputerUseSessionOptions {
  driver: InputDriver;
  proposer: VisionProposer;
  goal: string;
  /** When absent, sensitive actions are DENIED (fail closed). */
  approvalGate?: ApprovalGate;
  secretResolver?: SecretResolver;
  maxSteps?: number;
  /** Bound on the screenshot ring buffer. */
  historyLimit?: number;
}

export type SessionEndReason =
  "done" | "max_steps" | "stopped" | "takeover" | "approval_denied" | "error";

export interface SessionSummary {
  reason: SessionEndReason;
  steps: number;
  trace: readonly TraceEntry[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The visual closed loop: capture → propose → sensitive-action gate →
 * execute → capture → verify, repeated until the proposer stops proposing,
 * a limit is hit, an approval is denied, or a human takes over.
 *
 * The loop never runs concurrently with itself: `run()` and `step()` share
 * one iteration primitive guarded by a busy flag.
 */
export class ComputerUseSession {
  private readonly driver: InputDriver;
  private readonly proposer: VisionProposer;
  private readonly goal: string;
  private readonly approvalGate: ApprovalGate | null;
  private readonly secretResolver: SecretResolver | null;
  private readonly maxSteps: number;
  private readonly historyLimit: number;

  private readonly trace: TraceEntry[] = [];
  private readonly screenshotRing: ScreenFrame[] = [];
  private stepCount = 0;
  private running = false;
  private paused = false;
  private stopRequested = false;
  private takeoverRequested = false;
  private resumeWaiters: Array<() => void> = [];

  constructor(options: ComputerUseSessionOptions) {
    this.driver = options.driver;
    this.proposer = options.proposer;
    this.goal = options.goal;
    this.approvalGate = options.approvalGate ?? null;
    this.secretResolver = options.secretResolver ?? null;
    this.maxSteps = options.maxSteps ?? 30;
    this.historyLimit = options.historyLimit ?? 8;
  }

  getTrace(): readonly TraceEntry[] {
    return this.trace;
  }

  /** Bounded ring of captured frames, oldest first. */
  getScreenshotHistory(): readonly ScreenFrame[] {
    return this.screenshotRing;
  }

  isPaused(): boolean {
    return this.paused;
  }

  /** Pause after the current action; the loop waits for resume()/stop(). */
  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    this.takeoverRequested = false;
    const waiters = this.resumeWaiters;
    this.resumeWaiters = [];
    for (const wake of waiters) {
      wake();
    }
  }

  /** Request a clean stop after the current action. */
  stop(): void {
    this.stopRequested = true;
    this.resume();
  }

  /** Human takeover: pause the loop and hand control to the operator. */
  takeover(): void {
    this.takeoverRequested = true;
    this.pause();
  }

  /** Runs the loop to completion (or a stop condition). */
  async run(): Promise<SessionSummary> {
    if (this.running) {
      throw new Error("session is already running");
    }
    this.running = true;
    try {
      let reason: SessionEndReason = "done";
      for (;;) {
        await this.waitIfPaused();
        if (this.stopRequested) {
          reason = "stopped";
          break;
        }
        if (this.takeoverRequested) {
          reason = "takeover";
          break;
        }
        if (this.stepCount >= this.maxSteps) {
          reason = "max_steps";
          break;
        }
        const outcome = await this.runIteration();
        if (outcome !== "continue") {
          reason = outcome;
          break;
        }
      }
      return { reason, steps: this.stepCount, trace: this.trace };
    } finally {
      this.running = false;
    }
  }

  /** Step mode: execute exactly one loop iteration. */
  async step(): Promise<Exclude<SessionEndReason, "stopped" | "takeover"> | "continue"> {
    if (this.running) {
      throw new Error("session is running; use run() or stop it first");
    }
    if (this.stepCount >= this.maxSteps) {
      return "max_steps";
    }
    return this.runIteration();
  }

  private async waitIfPaused(): Promise<void> {
    while (this.paused && !this.stopRequested) {
      await new Promise<void>((resolve) => {
        this.resumeWaiters.push(resolve);
      });
    }
  }

  private pushFrame(frame: ScreenFrame): void {
    this.screenshotRing.push(frame);
    while (this.screenshotRing.length > this.historyLimit) {
      this.screenshotRing.shift();
    }
  }

  private async runIteration(): Promise<
    "continue" | Exclude<SessionEndReason, "stopped" | "takeover">
  > {
    const frame = await this.driver.screenshot();
    this.pushFrame(frame);
    const observation: Observation = { frame, description: null, elements: [] };
    const context = this.buildContext(observation);
    const actions = await this.proposer.propose(context);
    if (actions.length === 0) {
      return "done";
    }
    this.stepCount += 1;
    for (const action of actions) {
      const outcome = await this.executeOne(action, frame);
      if (outcome !== "continue") {
        return outcome;
      }
    }
    return "continue";
  }

  private buildContext(observation: Observation): ComputerContext {
    const context: ComputerContext = {
      goal: this.goal,
      step: this.stepCount,
      observation,
      trace: this.trace,
      secretRefs: this.secretResolver?.listRefs() ?? [],
    };
    return context;
  }

  /**
   * Executes one action through gate → driver → verify. Returns "continue"
   * or the terminal reason for the whole loop.
   */
  private async executeOne(
    action: ComputerAction,
    proposedAgainst: ScreenFrame,
  ): Promise<"continue" | "approval_denied" | "error"> {
    const classification = classifyAction(action);
    let approval: TraceEntry["approval"] = "not_required";
    if (classification.sensitive) {
      if (this.approvalGate === null) {
        approval = "denied";
      } else {
        approval = (await this.approvalGate.requestApproval({
          action,
          classification,
          summary: `${action.kind}: ${classification.reasons.join("; ")}`,
          step: this.stepCount,
        }))
          ? "approved"
          : "denied";
      }
      if (approval === "denied") {
        this.trace.push({
          step: this.stepCount,
          action,
          sensitiveKinds: classification.kinds,
          approval,
          result: null,
          verification: null,
          at: nowIso(),
        });
        return "approval_denied";
      }
    }

    // Coordinate scaling check: the geometry the action was proposed against
    // must still match what the driver reports now, otherwise normalized
    // coordinates would land on the wrong pixels.
    const current = await this.driver.screenshot();
    this.pushFrame(current);
    let result: ActionResult;
    if (!geometryMatches(proposedAgainst, current)) {
      result = {
        action,
        ok: false,
        error:
          `display geometry changed between proposal and execution ` +
          `(${proposedAgainst.width}x${proposedAgainst.height}@${proposedAgainst.scaleFactor} -> ` +
          `${current.width}x${current.height}@${current.scaleFactor})`,
        startedAt: nowIso(),
        finishedAt: nowIso(),
      };
    } else {
      result = await this.dispatch(action);
    }

    let verification: VerificationResult | null = null;
    if (result.ok && this.proposer.verify !== undefined) {
      const after = await this.driver.screenshot();
      this.pushFrame(after);
      verification = await this.proposer.verify(action, result, {
        frame: after,
        description: null,
        elements: [],
      });
    }

    this.trace.push({
      step: this.stepCount,
      action,
      sensitiveKinds: classification.kinds,
      approval,
      result,
      verification,
      at: nowIso(),
    });
    return result.ok ? "continue" : "error";
  }

  /** Maps a ComputerAction onto InputDriver calls. Secrets resolved here only. */
  private async dispatch(action: ComputerAction): Promise<ActionResult> {
    const startedAt = nowIso();
    try {
      switch (action.kind) {
        case "mouse_move":
          await this.driver.moveTo(action.point);
          break;
        case "click":
          await this.driver.click(action.point, action.button);
          break;
        case "double_click":
          await this.driver.doubleClick(action.point, action.button);
          break;
        case "drag":
          await this.driver.drag(action.from, action.to, action.button);
          break;
        case "scroll":
          await this.driver.scroll(action.point, action.deltaX, action.deltaY);
          break;
        case "type":
          await this.driver.typeText(action.text);
          break;
        case "key_press":
          await this.driver.keyPress(action.key, action.modifiers);
          break;
        case "shortcut":
          await this.driver.shortcut(action.keys);
          break;
        case "launch_app":
          await this.driver.launchApp(action.app, action.args);
          break;
        case "switch_window": {
          const activate = this.driver.activateWindow?.bind(this.driver);
          if (activate === undefined || !(await activate(action.target))) {
            throw new Error(`cannot switch to window "${action.target}" on this driver`);
          }
          break;
        }
        case "wait":
          await sleep(Math.max(0, action.ms));
          break;
        case "screenshot": {
          const frame = await this.driver.screenshot();
          this.pushFrame(frame);
          break;
        }
        case "choose_file":
          // Best effort: file dialogs accept a typed absolute path + Return.
          await this.driver.typeText(action.paths.join("\n"));
          await this.driver.keyPress("return");
          break;
        case "secure_fill": {
          if (this.secretResolver === null) {
            throw new Error("secure_fill action but no SecretResolver configured");
          }
          if (action.point !== undefined) {
            await this.driver.click(action.point);
          }
          const value = await this.secretResolver.resolve(action.secretRef);
          // Defense in depth: the resolved value must never have leaked into
          // anything the proposer has already seen.
          assertNoSecretLeak(this.trace, value);
          assertNoSecretLeak(
            this.buildContext({
              frame: this.screenshotRing[this.screenshotRing.length - 1] ?? {
                width: 0,
                height: 0,
                scaleFactor: 1,
                pngBase64: "",
                capturedAt: startedAt,
                displayId: "unknown",
              },
              description: null,
              elements: [],
            }),
            value,
          );
          await this.driver.typeText(value);
          break;
        }
      }
      return { action, ok: true, error: null, startedAt, finishedAt: nowIso() };
    } catch (error) {
      return {
        action,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        startedAt,
        finishedAt: nowIso(),
      };
    }
  }
}
