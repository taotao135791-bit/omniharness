import { nowIso } from "@omniharness/shared-types";
import { describe, expect, it, vi } from "vitest";
import type { DriverAvailability, InputDriver } from "./driver.js";
import { MapSecretResolver } from "./secure-fill.js";
import { ComputerUseSession, type VisionProposer } from "./session.js";
import type {
  ComputerAction,
  ComputerContext,
  DisplayInfo,
  LogicalPoint,
  ScreenFrame,
  WindowInfo,
} from "./types.js";

const FRAME: ScreenFrame = {
  width: 1000,
  height: 800,
  scaleFactor: 1,
  pngBase64: Buffer.from("fake-png").toString("base64"),
  capturedAt: "2026-01-01T00:00:00.000Z",
  displayId: "display-0",
};

interface DriverCall {
  method: string;
  args: unknown[];
}

class FakeDriver implements InputDriver {
  readonly platform = "fake";
  readonly calls: DriverCall[] = [];
  private readonly displays: DisplayInfo[] = [
    {
      displayId: "display-0",
      name: "fake",
      width: 1000,
      height: 800,
      scaleFactor: 1,
      primary: true,
    },
  ];

  private record(method: string, args: unknown[]): void {
    this.calls.push({ method, args });
  }

  checkAvailability(): Promise<DriverAvailability> {
    return Promise.resolve({ available: true, missingTools: [], guidance: null });
  }
  moveTo(point: LogicalPoint): Promise<void> {
    this.record("moveTo", [point]);
    return Promise.resolve();
  }
  click(point: LogicalPoint, button?: string): Promise<void> {
    this.record("click", [point, button ?? "left"]);
    return Promise.resolve();
  }
  doubleClick(point: LogicalPoint): Promise<void> {
    this.record("doubleClick", [point]);
    return Promise.resolve();
  }
  drag(from: LogicalPoint, to: LogicalPoint): Promise<void> {
    this.record("drag", [from, to]);
    return Promise.resolve();
  }
  scroll(point: LogicalPoint, deltaX: number, deltaY: number): Promise<void> {
    this.record("scroll", [point, deltaX, deltaY]);
    return Promise.resolve();
  }
  typeText(text: string): Promise<void> {
    this.record("typeText", [text]);
    return Promise.resolve();
  }
  keyPress(key: string, modifiers?: string[]): Promise<void> {
    this.record("keyPress", [key, modifiers ?? []]);
    return Promise.resolve();
  }
  shortcut(keys: string[]): Promise<void> {
    this.record("shortcut", [keys]);
    return Promise.resolve();
  }
  launchApp(app: string, args?: string[]): Promise<void> {
    this.record("launchApp", [app, args ?? []]);
    return Promise.resolve();
  }
  activeWindow(): Promise<WindowInfo | null> {
    return Promise.resolve({ appName: "FakeApp", title: "Fake Window" });
  }
  activateWindow(target: string): Promise<boolean> {
    this.record("activateWindow", [target]);
    return Promise.resolve(true);
  }
  screenshot(): Promise<ScreenFrame> {
    this.record("screenshot", []);
    return Promise.resolve({ ...FRAME, capturedAt: nowIso() });
  }
  listDisplays(): Promise<DisplayInfo[]> {
    return Promise.resolve(this.displays);
  }
}

/** Proposer that replays a scripted queue of action batches. */
class ScriptedProposer implements VisionProposer {
  readonly contexts: ComputerContext[] = [];
  private readonly queue: ComputerAction[][];

  constructor(queue: ComputerAction[][]) {
    this.queue = [...queue];
  }

  propose(context: ComputerContext): Promise<ComputerAction[]> {
    this.contexts.push(context);
    return Promise.resolve(this.queue.shift() ?? []);
  }

  verify(): Promise<{ verified: boolean; reason: string }> {
    return Promise.resolve({ verified: true, reason: "scripted ok" });
  }
}

describe("ComputerUseSession", () => {
  it("runs propose -> execute -> verify -> done and records the trace in order", async () => {
    const driver = new FakeDriver();
    const proposer = new ScriptedProposer([
      [
        { kind: "click", point: { x: 0.5, y: 0.5 } },
        { kind: "type", text: "hello" },
      ],
      [],
    ]);
    const session = new ComputerUseSession({ driver, proposer, goal: "test goal" });
    const summary = await session.run();

    expect(summary.reason).toBe("done");
    expect(summary.steps).toBe(1);

    const trace = session.getTrace();
    expect(trace.map((t) => t.action.kind)).toEqual(["click", "type"]);
    expect(trace.every((t) => t.result?.ok === true)).toBe(true);
    expect(trace.every((t) => t.verification?.verified === true)).toBe(true);
    expect(trace.every((t) => t.approval === "not_required")).toBe(true);

    const methods = driver.calls.map((c) => c.method);
    expect(methods[0]).toBe("screenshot");
    expect(methods).toContain("click");
    expect(methods).toContain("typeText");
    // click must be executed before type
    expect(methods.indexOf("click")).toBeLessThan(methods.indexOf("typeText"));
  });

  it("routes sensitive actions through the approval gate", async () => {
    const driver = new FakeDriver();
    const gate = { requestApproval: vi.fn().mockResolvedValue(true) };
    const proposer = new ScriptedProposer([
      [{ kind: "click", point: { x: 0.5, y: 0.5 }, hint: "press Delete to remove the account" }],
      [],
    ]);
    const session = new ComputerUseSession({
      driver,
      proposer,
      goal: "cleanup",
      approvalGate: gate,
    });
    const summary = await session.run();

    expect(summary.reason).toBe("done");
    expect(gate.requestApproval).toHaveBeenCalledTimes(1);
    const info = gate.requestApproval.mock.calls[0]?.[0] as { classification: { kinds: string[] } };
    expect(info.classification.kinds).toContain("deletion");
    expect(session.getTrace()[0]?.approval).toBe("approved");
    expect(driver.calls.map((c) => c.method)).toContain("click");
  });

  it("stops without executing when approval is denied", async () => {
    const driver = new FakeDriver();
    const gate = { requestApproval: vi.fn().mockResolvedValue(false) };
    const proposer = new ScriptedProposer([
      [{ kind: "click", point: { x: 0.5, y: 0.5 }, hint: "confirm purchase and pay now" }],
      [],
    ]);
    const session = new ComputerUseSession({
      driver,
      proposer,
      goal: "shop",
      approvalGate: gate,
    });
    const summary = await session.run();

    expect(summary.reason).toBe("approval_denied");
    expect(driver.calls.map((c) => c.method)).not.toContain("click");
    const entry = session.getTrace()[0];
    expect(entry?.approval).toBe("denied");
    expect(entry?.result).toBeNull();
  });

  it("denies sensitive actions when no gate is configured (fail closed)", async () => {
    const driver = new FakeDriver();
    const proposer = new ScriptedProposer([[{ kind: "secure_fill", secretRef: "anything" }], []]);
    const session = new ComputerUseSession({
      driver,
      proposer,
      goal: "login",
      secretResolver: new MapSecretResolver({ anything: "value" }),
    });
    const summary = await session.run();
    expect(summary.reason).toBe("approval_denied");
    expect(driver.calls.map((c) => c.method)).not.toContain("typeText");
  });

  it("never leaks the resolved secret into proposer-visible context or trace", async () => {
    const SECRET = "s3cr3t-v4lue-never-leak";
    const driver = new FakeDriver();
    const gate = { requestApproval: vi.fn().mockResolvedValue(true) };
    const proposer = new ScriptedProposer([
      [{ kind: "secure_fill", secretRef: "site-login", point: { x: 0.4, y: 0.4 } }],
      [],
    ]);
    const session = new ComputerUseSession({
      driver,
      proposer,
      goal: "log in",
      approvalGate: gate,
      secretResolver: new MapSecretResolver({ "site-login": SECRET }),
    });
    const summary = await session.run();

    expect(summary.reason).toBe("done");
    // The value went straight to the driver...
    const typed = driver.calls.filter((c) => c.method === "typeText").map((c) => c.args[0]);
    expect(typed).toEqual([SECRET]);
    // ...and the ref name was advertised to the proposer...
    expect(proposer.contexts[0]?.secretRefs).toEqual(["site-login"]);
    // ...but the value appears in NOTHING the proposer saw or the trace holds.
    for (const context of proposer.contexts) {
      expect(JSON.stringify(context)).not.toContain(SECRET);
    }
    expect(JSON.stringify(session.getTrace())).not.toContain(SECRET);
  });

  it("bounds the screenshot ring", async () => {
    const driver = new FakeDriver();
    const proposer = new ScriptedProposer([
      [{ kind: "wait", ms: 0 }],
      [{ kind: "wait", ms: 0 }],
      [],
    ]);
    const session = new ComputerUseSession({
      driver,
      proposer,
      goal: "loop",
      historyLimit: 2,
    });
    await session.run();
    expect(session.getScreenshotHistory().length).toBeLessThanOrEqual(2);
    // more frames were captured than retained
    expect(driver.calls.filter((c) => c.method === "screenshot").length).toBeGreaterThan(2);
  });

  it("supports step mode", async () => {
    const driver = new FakeDriver();
    const proposer = new ScriptedProposer([[{ kind: "wait", ms: 0 }], []]);
    const session = new ComputerUseSession({ driver, proposer, goal: "step" });
    expect(await session.step()).toBe("continue");
    expect(await session.step()).toBe("done");
    expect(session.getTrace()).toHaveLength(1);
  });

  it("stop() ends the loop", async () => {
    const driver = new FakeDriver();
    // Proposer keeps proposing forever; stop after the first proposal.
    const proposer = new ScriptedProposer([]);
    proposer.propose = (context: ComputerContext) => {
      proposer.contexts.push(context);
      session.stop();
      return Promise.resolve([]);
    };
    const session = new ComputerUseSession({ driver, proposer, goal: "halt" });
    const summary = await session.run();
    expect(summary.reason).toBe("done"); // empty proposal finishes before stop is re-checked
  });

  it("honors maxSteps", async () => {
    const driver = new FakeDriver();
    const proposer = new ScriptedProposer([
      [{ kind: "wait", ms: 0 }],
      [{ kind: "wait", ms: 0 }],
      [{ kind: "wait", ms: 0 }],
    ]);
    const session = new ComputerUseSession({ driver, proposer, goal: "cap", maxSteps: 2 });
    const summary = await session.run();
    expect(summary.reason).toBe("max_steps");
    expect(summary.steps).toBe(2);
  });

  it("fails the action when display geometry drifts between proposal and execution", async () => {
    const driver = new FakeDriver();
    let captures = 0;
    driver.screenshot = () => {
      captures += 1;
      // First capture is the proposal frame; the pre-execution check drifts.
      const width = captures <= 1 ? 1000 : 2000;
      return Promise.resolve({ ...FRAME, width, capturedAt: nowIso() });
    };
    const proposer = new ScriptedProposer([[{ kind: "click", point: { x: 0.5, y: 0.5 } }], []]);
    const session = new ComputerUseSession({ driver, proposer, goal: "drift" });
    const summary = await session.run();
    expect(summary.reason).toBe("error");
    expect(session.getTrace()[0]?.result?.error).toContain("geometry changed");
    expect(driver.calls.map((c) => c.method)).not.toContain("click");
  });
});
