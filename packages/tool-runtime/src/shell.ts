import { spawn } from "node:child_process";
import type { ToolOutputChunk } from "./types.js";

export interface ShellExecRequest {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  signal: AbortSignal;
  /** Receives output as it is produced (wired to ctx.emit by the tool). */
  onChunk?: (chunk: ToolOutputChunk) => void;
}

export interface ShellExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

/** Abstraction over sandboxed command execution (implemented by sandbox-engine). */
export interface SandboxExecutor {
  exec(req: ShellExecRequest): Promise<ShellExecResult>;
}

const DEFAULT_MAX_BUFFER = 1024 * 1024;

function appendCapped(buffer: string, chunk: string, cap: number): string {
  if (buffer.length >= cap) return buffer;
  return buffer.length + chunk.length <= cap
    ? buffer + chunk
    : buffer + chunk.slice(0, cap - buffer.length);
}

/**
 * Local, unsandboxed executor using child_process.spawn. Enforces a timeout
 * (SIGKILL) and streams output through `req.onChunk` while buffering the
 * result up to a cap.
 */
export class LocalShellExecutor implements SandboxExecutor {
  private readonly maxBufferBytes: number;

  constructor(opts?: { maxBufferBytes?: number }) {
    this.maxBufferBytes = opts?.maxBufferBytes ?? DEFAULT_MAX_BUFFER;
  }

  exec(req: ShellExecRequest): Promise<ShellExecResult> {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;

      let child;
      try {
        child = spawn(req.command, req.args, { cwd: req.cwd });
      } catch (error) {
        reject(error);
        return;
      }

      const finish = (exitCode: number): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        req.signal.removeEventListener("abort", onAbort);
        resolve({ exitCode, stdout, stderr, durationMs: Date.now() - started, timedOut });
      };

      const kill = (): void => {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
      };

      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, req.timeoutMs);

      const onAbort = (): void => {
        kill();
      };
      if (req.signal.aborted) {
        kill();
      } else {
        req.signal.addEventListener("abort", onAbort, { once: true });
      }

      child.stdout?.on("data", (data: Buffer) => {
        const text = data.toString("utf8");
        stdout = appendCapped(stdout, text, this.maxBufferBytes);
        req.onChunk?.({ stream: "stdout", text });
      });
      child.stderr?.on("data", (data: Buffer) => {
        const text = data.toString("utf8");
        stderr = appendCapped(stderr, text, this.maxBufferBytes);
        req.onChunk?.({ stream: "stderr", text });
      });
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        req.signal.removeEventListener("abort", onAbort);
        reject(error);
      });
      child.on("close", (code, signal) => {
        const exitCode = code ?? (timedOut ? 124 : signal === "SIGKILL" ? 137 : 1);
        finish(exitCode);
      });
    });
  }
}
