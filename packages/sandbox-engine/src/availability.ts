import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

/** Whether an executable with this name is found on the current PATH. */
export function commandOnPath(command: string): boolean {
  const pathEnv = process.env.PATH;
  if (!pathEnv) return false;
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, command), constants.X_OK);
      return true;
    } catch {
      // keep looking
    }
  }
  return false;
}

export interface ProbeOutcome {
  ok: boolean;
  detail: string;
}

/**
 * Lightweight availability probe: run a command, succeed on exit code 0.
 * Never rejects; a timeout kills the process and reports failure.
 */
export function probeCommand(argv: string[], timeoutMs: number): Promise<ProbeOutcome> {
  return new Promise((resolve) => {
    const [cmd, ...args] = argv;
    if (!cmd) {
      resolve({ ok: false, detail: "empty probe argv" });
      return;
    }

    let settled = false;
    let output = "";

    const finish = (ok: boolean, detail: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, detail });
    };

    let child;
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ ok: false, detail: err instanceof Error ? err.message : String(err) });
      return;
    }

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(false, `probe timed out after ${timeoutMs}ms`);
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.on("error", (err) => finish(false, err.message));
    child.on("close", (code) => {
      const trimmed = output.trim();
      finish(code === 0, code === 0 ? trimmed || "ok" : `exit code ${String(code)}: ${trimmed}`);
    });
  });
}
