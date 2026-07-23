import { commandOnPath } from "../availability.js";
import type { SandboxBackend, SandboxRequest, WrappedCommand } from "../types.js";

export interface SshBackendOptions {
  host: string;
  user?: string;
  port?: number;
}

/** POSIX single-quote shell escaping. */
export function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_\-./:=,%+@]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * SSH backend: runs the command on a remote host. The remote host is trusted
 * to provide isolation — this backend itself adds none, and the local
 * environment is NOT transferred to the remote side.
 */
export class SshBackend implements SandboxBackend {
  readonly name = "ssh";
  private readonly options: SshBackendOptions;
  private availability: Promise<boolean> | undefined;

  constructor(options: SshBackendOptions) {
    this.options = options;
  }

  isAvailable(): Promise<boolean> {
    this.availability ??= Promise.resolve(commandOnPath("ssh"));
    return this.availability;
  }

  wrap(req: SandboxRequest): WrappedCommand {
    const { host, user, port } = this.options;
    const target = user !== undefined ? `${user}@${host}` : host;
    const argv: string[] = ["ssh"];
    if (port !== undefined) {
      argv.push("-p", String(port));
    }
    argv.push(target, "--", req.argv.map(shellQuote).join(" "));
    return {
      argv,
      env: req.env,
      backend: this.name,
      warnings: [
        `ssh backend delegates isolation to the remote host "${target}"; the remote host is trusted to sandbox the command, and the local environment is NOT transferred`,
      ],
    };
  }
}
