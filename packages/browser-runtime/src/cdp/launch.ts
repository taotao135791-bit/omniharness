import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Locates and launches Chrome/Chromium/Edge with an isolated profile and
 * remote debugging on an OS-assigned port (--remote-debugging-port=0); the
 * chosen DevTools WebSocket URL is parsed from the browser's stderr line
 * "DevTools listening on ws://...".
 */

export interface LaunchOptions {
  /** Explicit browser binary; skips auto-detection. */
  executablePath?: string;
  /** Explicit isolated profile dir; a temp dir is created otherwise. */
  profileDir?: string;
  headless?: boolean;
  extraArgs?: string[];
  startupTimeoutMs?: number;
}

export interface LaunchedBrowser {
  wsUrl: string;
  profileDir: string;
  /** True when profileDir was created by us (and will be removed on close). */
  ownsProfile: boolean;
  process: ChildProcess;
  close(): Promise<void>;
}

function browserCandidates(platform: NodeJS.Platform): string[] {
  switch (platform) {
    case "darwin":
      return [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      ];
    case "win32": {
      const programFiles = [
        process.env.PROGRAMFILES,
        process.env["PROGRAMFILES(X86)"],
        process.env.LOCALAPPDATA,
      ].filter((dir): dir is string => typeof dir === "string");
      const suffixes = [
        "Google\\Chrome\\Application\\chrome.exe",
        "Chromium\\Application\\chrome.exe",
        "Microsoft\\Edge\\Application\\msedge.exe",
      ];
      return programFiles.flatMap((dir) => suffixes.map((suffix) => join(dir, suffix)));
    }
    case "linux":
      return [
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/usr/bin/microsoft-edge",
        "/snap/bin/chromium",
      ];
    default:
      return [];
  }
}

/** Returns the first existing browser binary for the platform, or null. */
export async function findBrowserBinary(
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  for (const candidate of browserCandidates(platform)) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // try next
    }
  }
  return null;
}

export async function launchBrowser(options: LaunchOptions = {}): Promise<LaunchedBrowser> {
  const executable = options.executablePath ?? (await findBrowserBinary());
  if (executable === null) {
    throw new Error(
      "no Chrome/Chromium/Edge binary found; pass executablePath or install a Chromium-based browser",
    );
  }
  const ownsProfile = options.profileDir === undefined;
  const profileDir = options.profileDir ?? (await mkdtemp(join(tmpdir(), "omniharness-profile-")));
  const args = [
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-session-crashed-bubble",
    "--hide-crash-restore-bubble",
    ...(options.headless === true ? ["--headless=new"] : []),
    ...(options.extraArgs ?? []),
    "about:blank",
  ];

  const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
  const startupTimeoutMs = options.startupTimeoutMs ?? 20_000;

  const wsUrl = await new Promise<string>((resolve, reject) => {
    let settled = false;
    let stderrBuffer = "";
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        reject(new Error(`browser did not report a DevTools URL within ${startupTimeoutMs}ms`));
      }
    }, startupTimeoutMs);

    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBuffer += chunk.toString("utf8");
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(stderrBuffer);
      if (match?.[1] !== undefined && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.once("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
    child.once("exit", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(
          new Error(
            `browser exited before reporting a DevTools URL (code ${String(code)}): ${stderrBuffer.slice(-500)}`,
          ),
        );
      }
    });
  });

  const close = async (): Promise<void> => {
    if (child.exitCode === null && !child.killed) {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 3_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    if (ownsProfile) {
      await rm(profileDir, { recursive: true, force: true, maxRetries: 3 });
    }
  };

  return { wsUrl, profileDir, ownsProfile, process: child, close };
}
