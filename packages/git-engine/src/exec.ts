import { execFile } from "node:child_process";
import { GitError } from "./errors.js";

export interface GitExecOptions {
  cwd: string;
  /** Text fed to the child's stdin (e.g. a patch for `git apply`). */
  input?: string;
  /** Extra environment variables merged over process.env. */
  env?: Record<string, string>;
}

export interface GitRawResult {
  code: number;
  stdout: string;
  stderr: string;
}

const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Runs `git` without a shell. Never interpolate user input into a command
 * string — every argument is passed through execFile's argv array.
 */
export function gitRaw(args: readonly string[], opts: GitExecOptions): Promise<GitRawResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      [...args],
      {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env },
        maxBuffer: MAX_BUFFER,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") {
          // Spawn-level failure (e.g. git not found, cwd missing).
          reject(
            new GitError(
              args,
              -1,
              String(stderr ?? "") || error.message,
              String(stdout ?? ""),
              opts.cwd,
            ),
          );
          return;
        }
        resolve({
          code: typeof error?.code === "number" ? error.code : 0,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
        });
      },
    );
    if (opts.input !== undefined && child.stdin) {
      child.stdin.write(opts.input);
    }
    child.stdin?.end();
  });
}

/** Like {@link gitRaw} but rejects with {@link GitError} on a non-zero exit. */
export async function git(args: readonly string[], opts: GitExecOptions): Promise<string> {
  const result = await gitRaw(args, opts);
  if (result.code !== 0) {
    throw new GitError(args, result.code, result.stderr, result.stdout, opts.cwd);
  }
  return result.stdout;
}
