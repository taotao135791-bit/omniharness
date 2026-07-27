import { spawn } from "node:child_process";
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

const XDOTOOL_KEYS: Record<string, string> = {
  return: "Return",
  enter: "Return",
  tab: "Tab",
  space: "space",
  backspace: "BackSpace",
  delete: "Delete",
  escape: "Escape",
  esc: "Escape",
  left: "Left",
  right: "Right",
  up: "Up",
  down: "Down",
  home: "Home",
  end: "End",
  pageup: "Page_Up",
  pagedown: "Page_Down",
  f1: "F1", f2: "F2", f3: "F3", f4: "F4", f5: "F5", f6: "F6",
  f7: "F7", f8: "F8", f9: "F9", f10: "F10", f11: "F11", f12: "F12",
};

const XDOTOOL_MODIFIERS: Record<string, string> = {
  ctrl: "ctrl",
  control: "ctrl",
  alt: "alt",
  option: "alt",
  shift: "shift",
  cmd: "super",
  command: "super",
  super: "super",
};

const BUTTON_NUMBERS: Record<MouseButton, number> = { left: 1, middle: 2, right: 3 };

export class LinuxInputDriver extends BaseInputDriver {
  readonly platform = "linux";

  async checkAvailability(): Promise<DriverAvailability> {
    if (process.platform !== "linux") {
      return {
        available: false,
        missingTools: [],
        guidance: "LinuxInputDriver only runs on Linux.",
      };
    }
    const sessionType = (process.env.XDG_SESSION_TYPE ?? "").toLowerCase();
    const onWayland =
      sessionType === "wayland" ||
      (process.env.WAYLAND_DISPLAY !== undefined && process.env.DISPLAY === undefined);
    if (onWayland) {
      return {
        available: false,
        missingTools: [],
        guidance:
          "Wayland session detected. xdotool/scrot only work on X11: Wayland compositors " +
          "deliberately block synthetic input and global capture. Options: log into an " +
          "X11 session, run the driver under Xwayland with DISPLAY set, or use a " +
          "compositor-specific portal (e.g. org.freedesktop.portal.RemoteDesktop).",
      };
    }
    const missing: string[] = [];
    if ((await findTool("xdotool")) === null) {
      missing.push("xdotool");
    }
    if ((await findTool("scrot")) === null) {
      missing.push("scrot");
    }
    return {
      available: missing.length === 0,
      missingTools: missing,
      guidance:
        missing.length === 0
          ? null
          : `Install missing tools: ${missing.join(" ")} (e.g. "sudo apt install ${missing.join(" ")}" or "sudo dnf install ${missing.join(" ")}").`,
    };
  }

  private async xdotool(args: string[]): Promise<string> {
    const result = await runFile("xdotool", args);
    if (result.code !== 0) {
      throw new Error(`xdotool ${args[0] ?? ""} failed: ${result.stderr.trim()}`);
    }
    return result.stdout.trim();
  }

  override async moveTo(point: LogicalPoint): Promise<void> {
    const p = await this.toPhysical(point);
    await this.xdotool(["mousemove", String(p.x), String(p.y)]);
  }

  override async click(point: LogicalPoint, button: MouseButton = "left"): Promise<void> {
    await this.moveTo(point);
    await this.xdotool(["click", String(BUTTON_NUMBERS[button])]);
  }

  override async doubleClick(point: LogicalPoint, button: MouseButton = "left"): Promise<void> {
    await this.moveTo(point);
    await this.xdotool(["click", "--repeat", "2", "--delay", "80", String(BUTTON_NUMBERS[button])]);
  }

  override async drag(
    from: LogicalPoint,
    to: LogicalPoint,
    button: MouseButton = "left",
  ): Promise<void> {
    const a = await this.toPhysical(from);
    const b = await this.toPhysical(to);
    const btn = String(BUTTON_NUMBERS[button]);
    await this.xdotool(["mousemove", String(a.x), String(a.y), "mousedown", btn]);
    const steps = 10;
    for (let i = 1; i <= steps; i += 1) {
      const x = Math.round(a.x + ((b.x - a.x) * i) / steps);
      const y = Math.round(a.y + ((b.y - a.y) * i) / steps);
      await this.xdotool(["mousemove", String(x), String(y)]);
    }
    await this.xdotool(["mouseup", btn]);
  }

  override async scroll(point: LogicalPoint, deltaX: number, deltaY: number): Promise<void> {
    await this.moveTo(point);
    // X11 buttons: 4 up, 5 down, 6 left, 7 right.
    const vertical = deltaY >= 0 ? "5" : "4";
    const horizontal = deltaX >= 0 ? "7" : "6";
    for (let i = 0; i < Math.abs(Math.round(deltaY)); i += 1) {
      await this.xdotool(["click", vertical]);
    }
    for (let i = 0; i < Math.abs(Math.round(deltaX)); i += 1) {
      await this.xdotool(["click", horizontal]);
    }
  }

  override async typeText(text: string): Promise<void> {
    await this.xdotool(["type", "--delay", "12", "--clearmodifiers", "--", text]);
  }

  override async keyPress(key: string, modifiers: string[] = []): Promise<void> {
    await this.xdotool(["key", this.keySequence(key, modifiers)]);
  }

  override async shortcut(keys: string[]): Promise<void> {
    if (keys.length === 0) {
      throw new Error("shortcut requires at least one key");
    }
    const key = keys[keys.length - 1] ?? "";
    await this.xdotool(["key", this.keySequence(key, keys.slice(0, -1))]);
  }

  private keySequence(key: string, modifiers: string[]): string {
    const mods = modifiers.map((m) => {
      const mapped = XDOTOOL_MODIFIERS[m.toLowerCase()];
      if (mapped === undefined) {
        throw new Error(`unsupported modifier key: ${m}`);
      }
      return mapped;
    });
    const mappedKey = XDOTOOL_KEYS[key.toLowerCase()] ?? (key.length === 1 ? key : null);
    if (mappedKey === null) {
      throw new Error(`unsupported key: ${key}`);
    }
    return [...mods, mappedKey].join("+");
  }

  override async launchApp(app: string, args: string[] = []): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(app, args, { detached: true, stdio: "ignore" });
      child.once("error", reject);
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    });
  }

  override async activeWindow(): Promise<WindowInfo | null> {
    try {
      const title = await this.xdotool(["getactivewindow", "getwindowname"]);
      let appName = title;
      try {
        appName = await this.xdotool(["getactivewindow", "getwindowclassname"]);
      } catch {
        // Fall back to the window title as the app name.
      }
      return { appName, title };
    } catch {
      return null;
    }
  }

  async activateWindow(target: string): Promise<boolean> {
    const result = await runFile("xdotool", [
      "search",
      "--name",
      target,
      "windowactivate",
      "%@",
    ]);
    return result.code === 0;
  }

  override async screenshot(): Promise<ScreenFrame> {
    const dir = await mkdtemp(join(tmpdir(), "omniharness-shot-"));
    const file = join(dir, "frame.png");
    try {
      const result = await runFile("scrot", ["-z", "-o", file]);
      if (result.code !== 0) {
        throw new Error(`scrot failed: ${result.stderr.trim()}`);
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
    const geometry = await this.xdotool(["getdisplaygeometry"]);
    const match = /^(\d+)\s+(\d+)$/.exec(geometry);
    if (match === null) {
      throw new Error(`unexpected xdotool getdisplaygeometry output: ${geometry}`);
    }
    return [
      {
        displayId: "display-0",
        name: "X11 default screen",
        width: Number.parseInt(match[1] ?? "0", 10),
        height: Number.parseInt(match[2] ?? "0", 10),
        scaleFactor: 1,
        primary: true,
      },
    ];
  }
}
