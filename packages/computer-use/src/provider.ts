import type { InputDriver } from "./driver.js";
import type { SecretResolver } from "./secure-fill.js";
import { classifyAction } from "./sensitive.js";
import type {
  ActionResult,
  ComputerAction,
  ComputerContext,
  Observation,
  ScreenFrame,
  VerificationResult,
} from "./types.js";
import type { ApprovalGate, VisionProposer } from "./session.js";

/**
 * The model-agnostic computer-use loop as a provider contract:
 * capture → inspect → propose → execute → verify. ComputerUseSession is the
 * reference runner over this shape; other hosts can implement the interface
 * directly (e.g. over a remote desktop transport).
 */
export interface ComputerUseProvider {
  capture(): Promise<ScreenFrame>;
  inspect(frame: ScreenFrame): Promise<Observation>;
  proposeActions(context: ComputerContext): Promise<ComputerAction[]>;
  execute(action: ComputerAction): Promise<ActionResult>;
  verify(action: ComputerAction, result: ActionResult): Promise<VerificationResult>;
}

export interface ComposedProviderOptions {
  driver: InputDriver;
  proposer: VisionProposer;
  approvalGate?: ApprovalGate;
  secretResolver?: SecretResolver;
  /** Custom frame inspector; defaults to a frame-only observation. */
  inspect?: (frame: ScreenFrame) => Promise<Observation>;
}

/**
 * Default provider wiring a driver + proposer together. The sensitive-action
 * gate is enforced in `execute` so even direct provider callers cannot skip
 * it: sensitive actions without an approving gate are rejected.
 */
export class ComposedComputerUseProvider implements ComputerUseProvider {
  private readonly driver: InputDriver;
  private readonly proposer: VisionProposer;
  private readonly approvalGate: ApprovalGate | null;
  private readonly secretResolver: SecretResolver | null;
  private readonly inspector: ((frame: ScreenFrame) => Promise<Observation>) | null;
  private lastObservation: Observation | null = null;

  constructor(options: ComposedProviderOptions) {
    this.driver = options.driver;
    this.proposer = options.proposer;
    this.approvalGate = options.approvalGate ?? null;
    this.secretResolver = options.secretResolver ?? null;
    this.inspector = options.inspect ?? null;
  }

  capture(): Promise<ScreenFrame> {
    return this.driver.screenshot();
  }

  async inspect(frame: ScreenFrame): Promise<Observation> {
    const observation =
      this.inspector !== null
        ? await this.inspector(frame)
        : { frame, description: null, elements: [] };
    this.lastObservation = observation;
    return observation;
  }

  proposeActions(context: ComputerContext): Promise<ComputerAction[]> {
    return this.proposer.propose(context);
  }

  async execute(action: ComputerAction): Promise<ActionResult> {
    const startedAt = new Date().toISOString();
    const classification = classifyAction(action);
    if (classification.sensitive) {
      const approved =
        this.approvalGate !== null &&
        (await this.approvalGate.requestApproval({
          action,
          classification,
          summary: `${action.kind}: ${classification.reasons.join("; ")}`,
          step: 0,
        }));
      if (!approved) {
        return {
          action,
          ok: false,
          error: "sensitive action denied",
          startedAt,
          finishedAt: new Date().toISOString(),
        };
      }
    }
    try {
      if (action.kind === "secure_fill") {
        if (this.secretResolver === null) {
          throw new Error("secure_fill action but no SecretResolver configured");
        }
        if (action.point !== undefined) {
          await this.driver.click(action.point);
        }
        await this.driver.typeText(await this.secretResolver.resolve(action.secretRef));
      } else {
        await this.dispatchNonSecret(action);
      }
      return { action, ok: true, error: null, startedAt, finishedAt: new Date().toISOString() };
    } catch (error) {
      return {
        action,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        startedAt,
        finishedAt: new Date().toISOString(),
      };
    }
  }

  private async dispatchNonSecret(action: Exclude<ComputerAction, { kind: "secure_fill" }>): Promise<void> {
    switch (action.kind) {
      case "mouse_move": await this.driver.moveTo(action.point); break;
      case "click": await this.driver.click(action.point, action.button); break;
      case "double_click": await this.driver.doubleClick(action.point, action.button); break;
      case "drag": await this.driver.drag(action.from, action.to, action.button); break;
      case "scroll": await this.driver.scroll(action.point, action.deltaX, action.deltaY); break;
      case "type": await this.driver.typeText(action.text); break;
      case "key_press": await this.driver.keyPress(action.key, action.modifiers); break;
      case "shortcut": await this.driver.shortcut(action.keys); break;
      case "launch_app": await this.driver.launchApp(action.app, action.args); break;
      case "switch_window": {
        const activate = this.driver.activateWindow?.bind(this.driver);
        if (activate === undefined || !(await activate(action.target))) {
          throw new Error(`cannot switch to window "${action.target}"`);
        }
        break;
      }
      case "wait": await new Promise((r) => setTimeout(r, Math.max(0, action.ms))); break;
      case "screenshot": await this.driver.screenshot(); break;
      case "choose_file":
        await this.driver.typeText(action.paths.join("\n"));
        await this.driver.keyPress("return");
        break;
    }
  }

  async verify(action: ComputerAction, result: ActionResult): Promise<VerificationResult> {
    if (this.proposer.verify === undefined) {
      return { verified: result.ok, reason: "no verifier configured" };
    }
    const frame = await this.driver.screenshot();
    const observation: Observation = this.lastObservation ?? { frame, description: null, elements: [] };
    return this.proposer.verify(action, result, observation);
  }
}
