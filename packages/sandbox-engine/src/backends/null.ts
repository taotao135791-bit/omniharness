import type { SandboxBackend, SandboxRequest, WrappedCommand } from "../types.js";

export const NULL_BACKEND_WARNING =
  "null backend: command runs without sandbox isolation";

/** Fallback backend: no isolation at all, always available. */
export class NullBackend implements SandboxBackend {
  readonly name = "null";

  isAvailable(): Promise<boolean> {
    return Promise.resolve(true);
  }

  wrap(req: SandboxRequest): WrappedCommand {
    return {
      argv: [...req.argv],
      env: req.env,
      backend: this.name,
      warnings: [NULL_BACKEND_WARNING],
    };
  }
}
