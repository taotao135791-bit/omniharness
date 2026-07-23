import { spawn } from "node:child_process";
import { BwrapBackend } from "./backends/bwrap.js";
import { DockerBackend } from "./backends/docker.js";
import { NullBackend } from "./backends/null.js";
import { SeatbeltBackend } from "./backends/seatbelt.js";
import { SshBackend, type SshBackendOptions } from "./backends/ssh.js";
import type {
  BackendProbeResult,
  SandboxBackend,
  SandboxDiagnostics,
  SandboxRequest,
  SandboxRunResult,
} from "./types.js";

export type SandboxBackendName = "auto" | "seatbelt" | "bwrap" | "docker" | "ssh" | "null";

export interface SandboxEngineOptions {
  /** Explicit backend list; defaults to auto-detect set (seatbelt, bwrap, docker, null). */
  backends?: SandboxBackend[];
  /** Backend selection strategy; default "auto". */
  backend?: SandboxBackendName;
  /** Env var names exempt from secret stripping. */
  envAllowlist?: string[];
  /** Timeout for backend availability probes. */
  probeTimeoutMs?: number;
  /** Required when `backend` is "ssh" and no ssh backend is passed explicitly. */
  ssh?: SshBackendOptions;
}

const SECRET_NAME_PATTERN = /KEY|TOKEN|SECRET|PASSWORD/i;

/**
 * Strip environment variables whose NAME looks like a secret
 * (KEY / TOKEN / SECRET / PASSWORD), unless the exact name is allowlisted.
 */
export function filterEnv(
  env: Record<string, string>,
  allowlist: readonly string[] = [],
): Record<string, string> {
  const allowed = new Set(allowlist);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (SECRET_NAME_PATTERN.test(key) && !allowed.has(key)) continue;
    out[key] = value;
  }
  return out;
}

export class SandboxEngine {
  private readonly backends: SandboxBackend[];
  private readonly backendName: SandboxBackendName;
  private readonly envAllowlist: string[];
  private readonly sshOptions: SshBackendOptions | undefined;

  private selected: SandboxBackend | null = null;
  private probes: BackendProbeResult[] = [];
  private warnings: string[] = [];
  private strippedEnvCount = 0;

  constructor(options: SandboxEngineOptions = {}) {
    this.backends = options.backends ?? [
      new SeatbeltBackend(),
      new BwrapBackend(),
      new DockerBackend(
        options.probeTimeoutMs !== undefined
          ? { probeTimeoutMs: options.probeTimeoutMs }
          : {},
      ),
      new NullBackend(),
    ];
    this.backendName = options.backend ?? "auto";
    this.envAllowlist = options.envAllowlist ?? [];
    this.sshOptions = options.ssh;
  }

  /**
   * Pick the backend to use. "auto" probes seatbelt → bwrap → docker in
   * order, first available wins, falling back to the null backend; a named
   * backend is used directly and throws when unavailable.
   */
  async selectBackend(): Promise<SandboxBackend> {
    if (this.selected !== null) return this.selected;

    if (this.backendName === "auto") {
      for (const backend of this.backends) {
        if (backend.name === "null") continue;
        if (await this.probe(backend)) {
          this.selected = backend;
          return backend;
        }
      }
      const nullBackend =
        this.backends.find((b) => b.name === "null") ?? new NullBackend();
      this.probes.push({
        backend: nullBackend.name,
        available: true,
        detail: "fallback: no isolating backend available",
      });
      this.warnings.push(
        "no isolating sandbox backend available; falling back to the null backend (no isolation)",
      );
      this.selected = nullBackend;
      return nullBackend;
    }

    const backend = this.resolveNamedBackend(this.backendName);
    if (!(await this.probe(backend))) {
      throw new Error(
        `sandbox backend "${this.backendName}" is not available on this host`,
      );
    }
    this.selected = backend;
    return backend;
  }

  /** Run a command inside the selected sandbox. */
  async run(req: SandboxRequest): Promise<SandboxRunResult> {
    const started = Date.now();
    const backend = await this.selectBackend();

    const filteredEnv = filterEnv(req.env, this.envAllowlist);
    this.strippedEnvCount +=
      Object.keys(req.env).length - Object.keys(filteredEnv).length;

    const wrapped = backend.wrap({ ...req, env: filteredEnv });
    const warnings = [...wrapped.warnings];

    const [cmd, ...args] = wrapped.argv;
    if (cmd === undefined) {
      throw new Error(`backend "${backend.name}" produced an empty argv`);
    }

    const { exitCode, stdout, stderr, timedOut, spawnError } = await new Promise<{
      exitCode: number | null;
      stdout: string;
      stderr: string;
      timedOut: boolean;
      spawnError: string | null;
    }>((resolve) => {
      let settled = false;
      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const finish = (exitCode: number | null, spawnError: string | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ exitCode, stdout, stderr, timedOut, spawnError });
      };

      const child = spawn(cmd, args, {
        cwd: req.cwd,
        env: wrapped.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, req.limits.timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (err) => finish(null, err.message));
      child.on("close", (code) => finish(code, null));
    });

    if (timedOut) {
      warnings.push(
        `command exceeded timeout of ${req.limits.timeoutMs}ms; killed with SIGKILL`,
      );
    }
    if (spawnError !== null) {
      warnings.push(`failed to spawn command: ${spawnError}`);
    }

    this.warnings.push(...warnings);

    return {
      backend: backend.name,
      exitCode,
      stdout,
      stderr,
      warnings,
      durationMs: Date.now() - started,
    };
  }

  /** Diagnostics snapshot for the security UI. */
  diagnostics(): SandboxDiagnostics {
    return {
      selectedBackend: this.selected?.name ?? null,
      probes: [...this.probes],
      strippedEnvCount: this.strippedEnvCount,
      warnings: [...this.warnings],
    };
  }

  private resolveNamedBackend(name: Exclude<SandboxBackendName, "auto">): SandboxBackend {
    const found = this.backends.find((b) => b.name === name);
    if (found) return found;
    if (name === "ssh") {
      if (this.sshOptions === undefined) {
        throw new Error(
          'backend "ssh" requires options.ssh (host) or an explicit SshBackend in options.backends',
        );
      }
      return new SshBackend(this.sshOptions);
    }
    throw new Error(`sandbox backend "${name}" is not configured`);
  }

  private async probe(backend: SandboxBackend): Promise<boolean> {
    try {
      const available = await backend.isAvailable();
      this.probes.push({ backend: backend.name, available });
      return available;
    } catch (err) {
      this.probes.push({
        backend: backend.name,
        available: false,
        detail: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }
}
