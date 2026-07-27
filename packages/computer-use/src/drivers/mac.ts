import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nowIso } from "@omniharness/shared-types";
import { findTool, runFile } from "../exec.js";
import type { DriverAvailability } from "../driver.js";
import type {
  DisplayInfo,
  LogicalPoint,
  MouseButton,
  ScreenFrame,
  WindowInfo,
} from "../types.js";
import { BaseInputDriver } from "./base.js";

/**
 * JXA (osascript -l JavaScript) mouse actuator. The event batch arrives as a
 * single JSON argv element, so no part of user data is ever interpolated
 * into the script source.
 *
 * CGEventType numeric values (stable CoreGraphics ABI):
 *   1 leftDown  2 leftUp  3 rightDown  4 rightUp  5 mouseMoved
 *   25 otherDown 26 otherUp
 * CGMouseButton: 0 left, 1 right, 2 middle. Tap 0 = kCGHIDEventTap.
 * Scroll units 1 = kCGScrollEventUnitLine.
 */
const MOUSE_JXA = `
function run(argv) {
  var spec = JSON.parse(argv[0]);
  ObjC.import("Quartz");
  var TYPES = { move: 5, leftDown: 1, leftUp: 2, rightDown: 3, rightUp: 4, middleDown: 25, middleUp: 26 };
  var BUTTONS = { left: 0, right: 1, middle: 2 };
  function post(ev) { $.CGEventPost(0, ev); }
  spec.events.forEach(function (e) {
    if (e.op === "scroll") {
      post($.CGEventCreateScrollWheelEvent($(), 1, 2, -e.dy, e.dx));
      delay(0.02);
      return;
    }
    var ev = $.CGEventCreateMouseEvent($(), TYPES[e.op], $.CGPointMake(e.x, e.y), BUTTONS[e.button] || 0);
    if (e.count && e.count > 1 && $.kCGMouseEventClickState !== undefined) {
      $.CGEventSetIntegerValueField(ev, $.kCGMouseEventClickState, e.count);
    }
    post(ev);
    delay(e.pause || 0.02);
  });
}
`;

type MouseOp =
  | { op: "move"; x: number; y: number }
  | { op: "leftDown" | "leftUp" | "rightDown" | "rightUp" | "middleDown" | "middleUp"; x: number; y: number; button: MouseButton; count?: number; pause?: number }
  | { op: "scroll"; dx: number; dy: number };

/** Escapes a string for embedding in an AppleScript double-quoted literal. */
function appleScriptString(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

const MODIFIER_MAP: Record<string, string> = {
  cmd: "command down",
  command: "command down",
  ctrl: "control down",
  control: "control down",
  alt: "option down",
  option: "option down",
  shift: "shift down",
  fn: "function down",
};

/** macOS virtual key codes for non-character keys. */
const KEY_CODES: Record<string, number> = {
  return: 36,
  enter: 36,
  tab: 48,
  space: 49,
  backspace: 51,
  delete: 117,
  escape: 53,
  esc: 53,
  left: 123,
  right: 124,
  down: 125,
  up: 126,
  home: 115,
  end: 119,
  pageup: 116,
  pagedown: 121,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97,
  f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111,
};

function modifierClause(modifiers: readonly string[]): string {
  if (modifiers.length === 0) {
    return "";
  }
  const parts = modifiers.map((m) => {
    const mapped = MODIFIER_MAP[m.toLowerCase()];
    if (mapped === undefined) {
      throw new Error(`unsupported modifier key: ${m}`);
    }
    return mapped;
  });
  return ` using {${parts.join(", ")}}`;
}

/** Builds a System Events keystroke script for a key name or single char. */
function keystrokeScript(key: string, modifiers: readonly string[]): string {
  const clause = modifierClause(modifiers);
  const code = KEY_CODES[key.toLowerCase()];
  if (code !== undefined) {
    return `tell application "System Events" to key code ${code}${clause}`;
  }
  if (key.length === 1) {
    return `tell application "System Events" to keystroke ${appleScriptString(key)}${clause}`;
  }
  throw new Error(`unsupported key: ${key}`);
}

export class MacInputDriver extends BaseInputDriver {
  readonly platform = "darwin";

  async checkAvailability(): Promise<DriverAvailability> {
    if (process.platform !== "darwin") {
      return {
        available: false,
        missingTools: [],
        guidance: "MacInputDriver only runs on macOS.",
      };
    }
    const tools = ["screencapture", "osascript", "open", "system_profiler"];
    const missing: string[] = [];
    for (const tool of tools) {
      if ((await findTool(tool)) === null) {
        missing.push(tool);
      }
    }
    return {
      available: missing.length === 0,
      missingTools: missing,
      guidance:
        missing.length === 0
          ? null
          : `Missing macOS built-in tools: ${missing.join(", ")}. These ship with macOS; check PATH.`,
    };
  }

  private async runMouseEvents(events: MouseOp[]): Promise<void> {
    const spec = JSON.stringify({ events });
    const result = await runFile("osascript", ["-l", "JavaScript", "-e", MOUSE_JXA, spec]);
    if (result.code !== 0) {
      throw new Error(`mouse event failed: ${result.stderr.trim()}`);
    }
  }

  private async osascript(script: string): Promise<string> {
    const result = await runFile("osascript", ["-e", script]);
    if (result.code !== 0) {
      throw new Error(`osascript failed: ${result.stderr.trim()}`);
    }
    return result.stdout.trim();
  }

  override async moveTo(point: LogicalPoint): Promise<void> {
    const p = await this.toOsPoints(point);
    await this.runMouseEvents([{ op: "move", x: p.x, y: p.y }]);
  }

  override async click(point: LogicalPoint, button: MouseButton = "left"): Promise<void> {
    const p = await this.toOsPoints(point);
    const down = button === "right" ? "rightDown" : button === "middle" ? "middleDown" : "leftDown";
    const up = button === "right" ? "rightUp" : button === "middle" ? "middleUp" : "leftUp";
    await this.runMouseEvents([
      { op: "move", x: p.x, y: p.y },
      { op: down, x: p.x, y: p.y, button },
      { op: up, x: p.x, y: p.y, button },
    ]);
  }

  override async doubleClick(point: LogicalPoint, button: MouseButton = "left"): Promise<void> {
    const p = await this.toOsPoints(point);
    const down = button === "right" ? "rightDown" : button === "middle" ? "middleDown" : "leftDown";
    const up = button === "right" ? "rightUp" : button === "middle" ? "middleUp" : "leftUp";
    await this.runMouseEvents([
      { op: "move", x: p.x, y: p.y },
      { op: down, x: p.x, y: p.y, button, count: 1 },
      { op: up, x: p.x, y: p.y, button, count: 1 },
      { op: down, x: p.x, y: p.y, button, count: 2 },
      { op: up, x: p.x, y: p.y, button, count: 2 },
    ]);
  }

  override async drag(
    from: LogicalPoint,
    to: LogicalPoint,
    button: MouseButton = "left",
  ): Promise<void> {
    const a = await this.toOsPoints(from);
    const b = await this.toOsPoints(to);
    const down = button === "right" ? "rightDown" : button === "middle" ? "middleDown" : "leftDown";
    const up = button === "right" ? "rightUp" : button === "middle" ? "middleUp" : "leftUp";
    const steps = 10;
    const events: MouseOp[] = [
      { op: "move", x: a.x, y: a.y },
      { op: down, x: a.x, y: a.y, button, pause: 0.05 },
    ];
    for (let i = 1; i <= steps; i += 1) {
      events.push({
        op: "move",
        x: a.x + ((b.x - a.x) * i) / steps,
        y: a.y + ((b.y - a.y) * i) / steps,
      });
    }
    events.push({ op: up, x: b.x, y: b.y, button });
    await this.runMouseEvents(events);
  }

  override async scroll(point: LogicalPoint, deltaX: number, deltaY: number): Promise<void> {
    const p = await this.toOsPoints(point);
    await this.runMouseEvents([
      { op: "move", x: p.x, y: p.y },
      { op: "scroll", dx: Math.round(deltaX), dy: Math.round(deltaY) },
    ]);
  }

  override async typeText(text: string): Promise<void> {
    const lines = text.split(/\r\n|\r|\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      if (line.length > 0) {
        await this.osascript(
          `tell application "System Events" to keystroke ${appleScriptString(line)}`,
        );
      }
      if (i < lines.length - 1) {
        await this.osascript(keystrokeScript("return", []));
      }
    }
  }

  override async keyPress(key: string, modifiers: string[] = []): Promise<void> {
    await this.osascript(keystrokeScript(key, modifiers));
  }

  override async shortcut(keys: string[]): Promise<void> {
    if (keys.length === 0) {
      throw new Error("shortcut requires at least one key");
    }
    const key = keys[keys.length - 1] ?? "";
    const modifiers = keys.slice(0, -1);
    await this.osascript(keystrokeScript(key, modifiers));
  }

  override async launchApp(app: string, args: string[] = []): Promise<void> {
    const argv = ["-a", app];
    if (args.length > 0) {
      argv.push("--args", ...args);
    }
    const result = await runFile("open", argv);
    if (result.code !== 0) {
      throw new Error(`failed to launch "${app}": ${result.stderr.trim()}`);
    }
  }

  override async activeWindow(): Promise<WindowInfo | null> {
    try {
      const appName = await this.osascript(
        'tell application "System Events" to get name of first application process whose frontmost is true',
      );
      let title: string | null = null;
      try {
        title = await this.osascript(
          `tell application "System Events" to get name of front window of (first application process whose frontmost is true)`,
        );
      } catch {
        title = null;
      }
      return { appName, title };
    } catch {
      return null;
    }
  }

  async activateWindow(target: string): Promise<boolean> {
    try {
      await this.osascript(
        `tell application "System Events" to set frontmost of (first application process whose name contains ${appleScriptString(target)}) to true`,
      );
      return true;
    } catch {
      return false;
    }
  }

  override async screenshot(): Promise<ScreenFrame> {
    const dir = await mkdtemp(join(tmpdir(), "omniharness-shot-"));
    const file = join(dir, "frame.png");
    try {
      const result = await runFile("screencapture", ["-x", file]);
      if (result.code !== 0) {
        throw new Error(`screencapture failed: ${result.stderr.trim()}`);
      }
      const png = await readFile(file);
      const display = await this.primaryDisplay();
      return {
        width: display.width,
        height: display.height,
        scaleFactor: display.scaleFactor,
        pngBase64: png.toString("base64"),
        capturedAt: nowIso(),
        displayId: display.displayId,
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  override async listDisplays(): Promise<DisplayInfo[]> {
    const result = await runFile("system_profiler", ["SPDisplaysDataType"], { timeoutMs: 60_000 });
    if (result.code !== 0) {
      throw new Error(`system_profiler failed: ${result.stderr.trim()}`);
    }
    return parseSystemProfilerDisplays(result.stdout);
  }
}

/**
 * Parses `system_profiler SPDisplaysDataType` text output into display
 * records. Display headers are indented 8 spaces under "Displays:"; property
 * lines are deeper ("Key: Value").
 */
export function parseSystemProfilerDisplays(output: string): DisplayInfo[] {
  const displays: DisplayInfo[] = [];
  let current: {
    name: string;
    width: number;
    height: number;
    looksWidth: number | null;
    looksHeight: number | null;
    retina: boolean;
    primary: boolean;
  } | null = null;

  const flush = (): void => {
    if (current === null || current.width === 0) {
      return;
    }
    const scaleFactor =
      current.looksWidth !== null && current.looksWidth > 0
        ? current.width / current.looksWidth
        : current.retina
          ? 2
          : 1;
    displays.push({
      displayId: `display-${displays.length}`,
      name: current.name,
      width: current.width,
      height: current.height,
      scaleFactor,
      primary: current.primary,
    });
  };

  for (const line of output.split(/\r?\n/)) {
    const header = /^ {8}(\S[^:]*):\s*$/.exec(line);
    if (header?.[1] !== undefined && !/^(Displays|Graphics\/Displays)$/.test(header[1])) {
      flush();
      current = {
        name: header[1].trim(),
        width: 0,
        height: 0,
        looksWidth: null,
        looksHeight: null,
        retina: false,
        primary: false,
      };
      continue;
    }
    if (current === null) {
      continue;
    }
    const resolution = /Resolution:\s*(\d+)\s*x\s*(\d+)(.*)$/.exec(line);
    if (resolution !== null) {
      current.width = Number.parseInt(resolution[1] ?? "0", 10);
      current.height = Number.parseInt(resolution[2] ?? "0", 10);
      current.retina = /retina/i.test(resolution[3] ?? "");
      continue;
    }
    const looks = /UI Looks like:\s*(\d+)\s*x\s*(\d+)/.exec(line);
    if (looks !== null) {
      current.looksWidth = Number.parseInt(looks[1] ?? "0", 10);
      current.looksHeight = Number.parseInt(looks[2] ?? "0", 10);
      continue;
    }
    if (/Main Display:\s*Yes/.test(line)) {
      current.primary = true;
    }
  }
  flush();
  if (displays.length > 0 && !displays.some((d) => d.primary)) {
    const first = displays[0];
    if (first !== undefined) {
      first.primary = true;
    }
  }
  return displays;
}
