/**
 * Core types for the sandbox engine: execution isolation for shell commands.
 */

export type NetworkPolicy = "off" | "allowlist" | "all";

export interface SandboxLimits {
  /** CPU cap as a percentage of one core (100 = one full core). */
  cpuPercent?: number;
  /** Memory cap in MiB. */
  memoryMb?: number;
  /** Wall-clock timeout; the process is SIGKILLed when exceeded. */
  timeoutMs: number;
}

export interface SandboxRequest {
  /** Command and arguments, executed without a shell. */
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  limits: SandboxLimits;
  network: NetworkPolicy;
  /**
   * Domains the command may reach when `network` is "allowlist". Most
   * backends cannot enforce domains themselves; they open the network and
   * leave enforcement to a proxy / network layer.
   */
  allowedDomains?: string[];
  /** Extra paths the command may read (read access is otherwise unrestricted). */
  readOnlyPaths?: string[];
  /** The only paths the command may write to. */
  writablePaths: string[];
}

export interface WrappedCommand {
  /** Full command line to spawn. */
  argv: string[];
  /** Filtered environment to spawn with. */
  env: Record<string, string>;
  /** Name of the backend that produced this command. */
  backend: string;
  /** Non-fatal caveats, e.g. the null-backend no-isolation warning. */
  warnings: string[];
}

export interface SandboxBackend {
  readonly name: string;
  isAvailable(): Promise<boolean>;
  wrap(cmd: SandboxRequest): WrappedCommand;
}

export interface SandboxRunResult {
  backend: string;
  /** Null when the process could not be started or the exit code is unknown. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  warnings: string[];
  durationMs: number;
}

export interface BackendProbeResult {
  backend: string;
  available: boolean;
  detail?: string;
}

export interface SandboxDiagnostics {
  selectedBackend: string | null;
  probes: BackendProbeResult[];
  /** Cumulative count of environment variables stripped by secret filtering. */
  strippedEnvCount: number;
  warnings: string[];
}
