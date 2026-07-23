import { commandOnPath } from "../availability.js";
import type { SandboxBackend, SandboxRequest, WrappedCommand } from "../types.js";

/** Linux bubblewrap backend. */
export class BwrapBackend implements SandboxBackend {
  readonly name = "bwrap";
  private availability: Promise<boolean> | undefined;

  isAvailable(): Promise<boolean> {
    this.availability ??= Promise.resolve(commandOnPath("bwrap"));
    return this.availability;
  }

  wrap(req: SandboxRequest): WrappedCommand {
    const argv: string[] = [
      "bwrap",
      "--ro-bind", "/", "/",
      "--dev", "/dev",
      "--proc", "/proc",
      "--tmpfs", "/tmp",
    ];
    for (const path of req.writablePaths) {
      argv.push("--bind", path, path);
    }
    if (req.network === "off") {
      argv.push("--unshare-net");
    }
    argv.push("--clearenv");
    for (const [key, value] of Object.entries(req.env)) {
      argv.push("--setenv", key, value);
    }
    argv.push("--chdir", req.cwd, "--", ...req.argv);

    const warnings: string[] = [];
    if (req.network === "allowlist") {
      warnings.push(
        "bwrap cannot enforce domain allowlists; network is shared and domains must be enforced at the network layer",
      );
    }

    return { argv, env: req.env, backend: this.name, warnings };
  }
}
