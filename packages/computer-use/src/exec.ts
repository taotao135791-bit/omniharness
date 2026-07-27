import { execFile } from "node:child_process";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  timeoutMs?: number;
  /** Extra environment merged over a minimal PATH-bearing base. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Runs a command via execFile with an argv array — never through a shell, so
 * no argument is ever subject to shell interpolation.
 */
export function runFile(
  file: string,
  args: readonly string[],
  options: ExecOptions = {},
): Promise<ExecResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      {
        timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
        env: { PATH: process.env.PATH ?? "", ...options.env },
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error !== null && error.code === undefined) {
          // Spawn-level failure (ENOENT, EACCES, timeout kill).
          reject(error);
          return;
        }
        resolve({
          code: typeof error?.code === "number" ? error.code : 0,
          stdout: String(stdout),
          stderr: String(stderr),
        });
      },
    );
  });
}

/** Locates an executable on PATH without a shell. Returns null when absent. */
export async function findTool(name: string): Promise<string | null> {
  const locator = process.platform === "win32" ? "where.exe" : "which";
  try {
    const result = await runFile(locator, [name], { timeoutMs: 5_000 });
    if (result.code !== 0) {
      return null;
    }
    const first = result.stdout.split(/\r?\n/).find((line) => line.trim().length > 0);
    return first !== undefined ? first.trim() : null;
  } catch {
    return null;
  }
}
