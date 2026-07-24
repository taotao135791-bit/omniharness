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
 * PowerShell mouse actuator using user32 SetCursorPos/mouse_event. The event
 * batch arrives as a JSON element of $args — nothing is interpolated into
 * the script source.
 */
const MOUSE_PS = `
$ev = $args[0] | ConvertFrom-Json
$sig = '[DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);' +
       '[DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint data, int extra);'
Add-Type -MemberDefinition $sig -Name U32 -Namespace OmniHarness -ErrorAction SilentlyContinue
foreach ($e in $ev.events) {
  switch ($e.op) {
    "move"       { [OmniHarness.U32]::SetCursorPos([int]$e.x, [int]$e.y) | Out-Null }
    "leftDown"   { [OmniHarness.U32]::mouse_event(0x02, 0, 0, 0, 0) }
    "leftUp"     { [OmniHarness.U32]::mouse_event(0x04, 0, 0, 0, 0) }
    "rightDown"  { [OmniHarness.U32]::mouse_event(0x08, 0, 0, 0, 0) }
    "rightUp"    { [OmniHarness.U32]::mouse_event(0x10, 0, 0, 0, 0) }
    "middleDown" { [OmniHarness.U32]::mouse_event(0x20, 0, 0, 0, 0) }
    "middleUp"   { [OmniHarness.U32]::mouse_event(0x40, 0, 0, 0, 0) }
    "scroll"     { [OmniHarness.U32]::mouse_event(0x0800, 0, 0, [uint32]([int](-$e.dy) * 120), 0) }
  }
  Start-Sleep -Milliseconds 20
}
`;

const SCREENSHOT_PS = `
Add-Type -AssemblyName System.Drawing, System.Windows.Forms
$s = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $s.Width, $s.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($s.Left, $s.Top, 0, 0, $bmp.Size)
$bmp.Save($args[0], [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
$gfx = [System.Drawing.Graphics]::FromHwnd([IntPtr]::Zero)
$dpi = $gfx.DpiX
$gfx.Dispose()
Write-Output "$($s.Width)x$($s.Height) $([math]::Round($dpi / 96, 3))"
`;

const DISPLAYS_PS = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
  "$($_.DeviceName)|$($_.Bounds.Width)x$($_.Bounds.Height)|$($_.Primary)"
}
`;

const ACTIVE_WINDOW_PS = `
$sig = '[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();' +
       '[DllImport("user32.dll")] public static extern int GetWindowText(System.IntPtr h, System.Text.StringBuilder t, int n);' +
       '[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint pid);'
Add-Type -MemberDefinition $sig -Name FG -Namespace OmniHarness -ErrorAction SilentlyContinue
$h = [OmniHarness.FG]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 512
[void][OmniHarness.FG]::GetWindowText($h, $sb, $sb.Capacity)
[uint32]$pid = 0
[void][OmniHarness.FG]::GetWindowThreadProcessId($h, [ref]$pid)
$p = Get-Process -Id $pid -ErrorAction SilentlyContinue
"$($p.ProcessName)|$($sb.ToString())"
`;

type MouseOp =
  | { op: "move"; x: number; y: number }
  | { op: string; x?: number; y?: number; dy?: number };

/** Escapes SendKeys metacharacters by wrapping each in braces. */
function sendKeysEscape(text: string): string {
  return text.replace(/[+^%~()[\]{}]/g, (ch) => `{${ch}}`);
}

const SENDKEYS_KEYS: Record<string, string> = {
  return: "{ENTER}",
  enter: "{ENTER}",
  tab: "{TAB}",
  space: " ",
  backspace: "{BACKSPACE}",
  delete: "{DELETE}",
  escape: "{ESC}",
  esc: "{ESC}",
  left: "{LEFT}",
  right: "{RIGHT}",
  up: "{UP}",
  down: "{DOWN}",
  home: "{HOME}",
  end: "{END}",
  pageup: "{PGUP}",
  pagedown: "{PGDN}",
  f1: "{F1}", f2: "{F2}", f3: "{F3}", f4: "{F4}", f5: "{F5}", f6: "{F6}",
  f7: "{F7}", f8: "{F8}", f9: "{F9}", f10: "{F10}", f11: "{F11}", f12: "{F12}",
};

const SENDKEYS_MODIFIERS: Record<string, string> = {
  ctrl: "^",
  control: "^",
  alt: "%",
  option: "%",
  shift: "+",
};

export class WindowsInputDriver extends BaseInputDriver {
  readonly platform = "win32";

  async checkAvailability(): Promise<DriverAvailability> {
    if (process.platform !== "win32") {
      return {
        available: false,
        missingTools: [],
        guidance: "WindowsInputDriver only runs on Windows.",
      };
    }
    const ps = (await findTool("powershell.exe")) ?? (await findTool("pwsh.exe"));
    return {
      available: ps !== null,
      missingTools: ps === null ? ["powershell.exe"] : [],
      guidance:
        ps === null
          ? "PowerShell not found on PATH. Install PowerShell or add powershell.exe to PATH."
          : null,
    };
  }

  private async powershell(script: string, args: string[] = []): Promise<string> {
    const shell = (await findTool("powershell.exe")) ?? (await findTool("pwsh.exe"));
    if (shell === null) {
      throw new Error("PowerShell is not available on this system");
    }
    const result = await runFile(
      shell,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script, ...args],
      { timeoutMs: 60_000 },
    );
    if (result.code !== 0) {
      throw new Error(`powershell failed: ${result.stderr.trim()}`);
    }
    return result.stdout.trim();
  }

  private async runMouseEvents(events: MouseOp[]): Promise<void> {
    await this.powershell(MOUSE_PS, [JSON.stringify({ events })]);
  }

  override async moveTo(point: LogicalPoint): Promise<void> {
    const p = await this.toPhysical(point);
    await this.runMouseEvents([{ op: "move", x: p.x, y: p.y }]);
  }

  override async click(point: LogicalPoint, button: MouseButton = "left"): Promise<void> {
    const p = await this.toPhysical(point);
    const down = `${button}Down`;
    const up = `${button}Up`;
    await this.runMouseEvents([
      { op: "move", x: p.x, y: p.y },
      { op: down },
      { op: up },
    ]);
  }

  override async doubleClick(point: LogicalPoint, button: MouseButton = "left"): Promise<void> {
    const p = await this.toPhysical(point);
    const down = `${button}Down`;
    const up = `${button}Up`;
    await this.runMouseEvents([
      { op: "move", x: p.x, y: p.y },
      { op: down },
      { op: up },
      { op: down },
      { op: up },
    ]);
  }

  override async drag(
    from: LogicalPoint,
    to: LogicalPoint,
    button: MouseButton = "left",
  ): Promise<void> {
    const a = await this.toPhysical(from);
    const b = await this.toPhysical(to);
    const steps = 10;
    const events: MouseOp[] = [
      { op: "move", x: a.x, y: a.y },
      { op: `${button}Down` },
    ];
    for (let i = 1; i <= steps; i += 1) {
      events.push({
        op: "move",
        x: Math.round(a.x + ((b.x - a.x) * i) / steps),
        y: Math.round(a.y + ((b.y - a.y) * i) / steps),
      });
    }
    events.push({ op: `${button}Up` });
    await this.runMouseEvents(events);
  }

  override async scroll(point: LogicalPoint, deltaX: number, deltaY: number): Promise<void> {
    const p = await this.toPhysical(point);
    const events: MouseOp[] = [{ op: "move", x: p.x, y: p.y }];
    const notches = Math.max(1, Math.abs(Math.round(deltaY)));
    for (let i = 0; i < notches; i += 1) {
      events.push({ op: "scroll", dy: Math.sign(deltaY) });
    }
    await this.runMouseEvents(events);
  }

  override async typeText(text: string): Promise<void> {
    const script = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait($args[0])
`;
    await this.powershell(script, [sendKeysEscape(text)]);
  }

  override async keyPress(key: string, modifiers: string[] = []): Promise<void> {
    await this.sendKeyCombo(key, modifiers);
  }

  override async shortcut(keys: string[]): Promise<void> {
    if (keys.length === 0) {
      throw new Error("shortcut requires at least one key");
    }
    const key = keys[keys.length - 1] ?? "";
    await this.sendKeyCombo(key, keys.slice(0, -1));
  }

  private async sendKeyCombo(key: string, modifiers: string[]): Promise<void> {
    const prefix = modifiers
      .map((m) => {
        const token = SENDKEYS_MODIFIERS[m.toLowerCase()];
        if (token === undefined) {
          throw new Error(`unsupported modifier key: ${m}`);
        }
        return token;
      })
      .join("");
    const token = SENDKEYS_KEYS[key.toLowerCase()];
    const body = token ?? (key.length === 1 ? sendKeysEscape(key) : null);
    if (body === null) {
      throw new Error(`unsupported key: ${key}`);
    }
    // Modifier prefixes only apply to the next group; wrap multi-key bodies.
    const sequence = prefix.length > 0 && body.length > 1 ? `${prefix}(${body})` : `${prefix}${body}`;
    const script = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait($args[0])
`;
    await this.powershell(script, [sequence]);
  }

  override async launchApp(app: string, args: string[] = []): Promise<void> {
    const script = `
$app = $args[0]
$rest = $args[1..($args.Count - 1)]
if ($rest.Count -gt 0) { Start-Process -FilePath $app -ArgumentList $rest } else { Start-Process -FilePath $app }
`;
    await this.powershell(script, [app, ...args]);
  }

  override async activeWindow(): Promise<WindowInfo | null> {
    try {
      const out = await this.powershell(ACTIVE_WINDOW_PS);
      const sep = out.indexOf("|");
      if (sep === -1) {
        return null;
      }
      return { appName: out.slice(0, sep), title: out.slice(sep + 1) };
    } catch {
      return null;
    }
  }

  override async screenshot(): Promise<ScreenFrame> {
    const dir = await mkdtemp(join(tmpdir(), "omniharness-shot-"));
    const file = join(dir, "frame.png");
    try {
      const out = await this.powershell(SCREENSHOT_PS, [file]);
      const match = /(\d+)x(\d+)\s+([\d.]+)/.exec(out);
      const png = await readFile(file);
      return {
        width: match !== null ? Number.parseInt(match[1] ?? "0", 10) : 0,
        height: match !== null ? Number.parseInt(match[2] ?? "0", 10) : 0,
        scaleFactor: match !== null ? Number.parseFloat(match[3] ?? "1") : 1,
        pngBase64: png.toString("base64"),
        capturedAt: nowIso(),
        displayId: "primary",
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  override async listDisplays(): Promise<DisplayInfo[]> {
    const out = await this.powershell(DISPLAYS_PS);
    const displays: DisplayInfo[] = [];
    for (const line of out.split(/\r?\n/)) {
      const match = /^(.+?)\|(\d+)x(\d+)\|(True|False)$/.exec(line.trim());
      if (match === null) {
        continue;
      }
      displays.push({
        displayId: `display-${displays.length}`,
        name: match[1] ?? "display",
        width: Number.parseInt(match[2] ?? "0", 10),
        height: Number.parseInt(match[3] ?? "0", 10),
        scaleFactor: 1,
        primary: match[4] === "True",
      });
    }
    if (displays.length === 0) {
      throw new Error("no displays reported by System.Windows.Forms.Screen");
    }
    return displays;
  }
}
