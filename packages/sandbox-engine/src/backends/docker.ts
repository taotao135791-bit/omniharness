import { commandOnPath, probeCommand } from "../availability.js";
import type { SandboxBackend, SandboxRequest, WrappedCommand } from "../types.js";

export const DEFAULT_DOCKER_IMAGE = "omniharness-sandbox:latest";

export interface DockerBackendOptions {
  image?: string;
  /** Timeout for the `docker version` availability probe. */
  probeTimeoutMs?: number;
}

/**
 * Pure builder for the `docker run` command line. Container is ephemeral
 * (--rm), capabilities dropped, no-new-privileges set, network per policy,
 * paths mounted ro/rw, resource limits applied, env passed through by name.
 */
export function buildDockerArgv(req: SandboxRequest, image: string): string[] {
  const argv: string[] = [
    "docker",
    "run",
    "--rm",
    "-i",
    "--network",
    req.network === "off" ? "none" : "bridge",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
  ];
  for (const path of req.readOnlyPaths ?? []) {
    argv.push("-v", `${path}:${path}:ro`);
  }
  for (const path of req.writablePaths) {
    argv.push("-v", `${path}:${path}:rw`);
  }
  if (req.limits.memoryMb !== undefined) {
    argv.push("--memory", `${req.limits.memoryMb}m`);
  }
  if (req.limits.cpuPercent !== undefined) {
    argv.push("--cpus", String(req.limits.cpuPercent / 100));
  }
  argv.push("-w", req.cwd);
  for (const key of Object.keys(req.env)) {
    // Passthrough by name: docker copies the value from the daemon-side
    // environment of the run invocation, keeping values out of the argv.
    argv.push("-e", key);
  }
  argv.push(image, ...req.argv);
  return argv;
}

export class DockerBackend implements SandboxBackend {
  readonly name = "docker";
  private readonly image: string;
  private readonly probeTimeoutMs: number;
  private availability: Promise<boolean> | undefined;

  constructor(options: DockerBackendOptions = {}) {
    this.image = options.image ?? DEFAULT_DOCKER_IMAGE;
    this.probeTimeoutMs = options.probeTimeoutMs ?? 2000;
  }

  isAvailable(): Promise<boolean> {
    this.availability ??= this.probe();
    return this.availability;
  }

  private async probe(): Promise<boolean> {
    if (!commandOnPath("docker")) return false;
    const outcome = await probeCommand(
      ["docker", "version", "--format", "{{.Server.Version}}"],
      this.probeTimeoutMs,
    );
    return outcome.ok;
  }

  wrap(req: SandboxRequest): WrappedCommand {
    const warnings: string[] = [];
    if (req.network === "allowlist") {
      warnings.push(
        "docker backend uses the bridge network for allowlist policy; domain enforcement must happen at the network layer (e.g. an egress proxy)",
      );
    }
    return {
      argv: buildDockerArgv(req, this.image),
      env: req.env,
      backend: this.name,
      warnings,
    };
  }
}
