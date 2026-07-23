import { realpathSync } from "node:fs";
import { commandOnPath } from "../availability.js";
import type { SandboxBackend, SandboxRequest, WrappedCommand } from "../types.js";

/** Escape a path for embedding inside a double-quoted seatbelt literal. */
function escapePath(path: string): string {
  return path.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * System paths that must stay readable for any process to start at all
 * (dyld shared cache, system libraries, shell binaries, resolver config).
 * Always included when reads are scoped via readOnlyPaths.
 */
const SYSTEM_READ_PATHS = [
  "/System",
  "/usr",
  "/bin",
  "/sbin",
  "/Library",
  "/private",
  "/dev",
  "/Applications",
];

/**
 * Pure generator for a macOS seatbelt (.sb) profile:
 * deny-by-default, process exec/fork allowed, reads unrestricted (or scoped to
 * readOnlyPaths + cwd when provided), writes scoped to writablePaths, and
 * network gated by the request's NetworkPolicy.
 */
export function generateSeatbeltProfile(req: SandboxRequest): string {
  const lines: string[] = [
    "(version 1)",
    "(deny default)",
    "",
    "; process management",
    "(allow process-exec)",
    "(allow process-fork)",
    "(allow signal (target self))",
    "(allow sysctl-read)",
    "",
    "; file reads",
  ];

  const readOnlyPaths = req.readOnlyPaths ?? [];
  if (readOnlyPaths.length === 0) {
    lines.push("(allow file-read*)");
  } else {
    const scopedReads = [...new Set([...SYSTEM_READ_PATHS, ...readOnlyPaths, req.cwd])];
    lines.push(
      "; system baseline plus readOnlyPaths + cwd",
      // dyld reads the root directory at startup; without this the process aborts.
      '(allow file-read* (literal "/"))',
    );
    for (const path of scopedReads) {
      lines.push(`(allow file-read* (subpath "${escapePath(path)}"))`);
    }
  }

  lines.push("", "; file writes (scoped to writablePaths)");
  for (const path of req.writablePaths) {
    lines.push(`(allow file-write* (subpath "${escapePath(path)}"))`);
  }

  lines.push("", "; network");
  switch (req.network) {
    case "off":
      lines.push("; network policy: off (no network rules emitted)");
      break;
    case "all":
      lines.push("(allow network*)");
      break;
    case "allowlist":
      lines.push(
        "; seatbelt cannot filter domains; domain allowlist is enforced at the network layer",
        `; allowed domains: ${(req.allowedDomains ?? []).join(", ") || "(none)"}`,
        "(allow network*)",
      );
      break;
  }

  return lines.join("\n") + "\n";
}

/**
 * Seatbelt matches against canonicalized paths, so symlinks like /tmp
 * (→ /private/tmp) must be resolved or the rule silently fails to apply.
 * Returns the original plus the resolved path (deduped); unresolvable
 * paths are kept as-is.
 */
function canonicalize(paths: readonly string[]): string[] {
  const out = new Set<string>();
  for (const path of paths) {
    out.add(path);
    try {
      out.add(realpathSync.native(path));
    } catch {
      // path may not exist yet; keep the literal form
    }
  }
  return [...out];
}

/** macOS sandbox-exec backend. */
export class SeatbeltBackend implements SandboxBackend {
  readonly name = "seatbelt";
  private availability: Promise<boolean> | undefined;

  isAvailable(): Promise<boolean> {
    this.availability ??= Promise.resolve(
      process.platform === "darwin" && commandOnPath("sandbox-exec"),
    );
    return this.availability;
  }

  wrap(req: SandboxRequest): WrappedCommand {
    const readScoped = req.readOnlyPaths !== undefined && req.readOnlyPaths.length > 0;
    const resolved: SandboxRequest = {
      ...req,
      writablePaths: canonicalize(req.writablePaths),
      // Canonical cwd is folded into the read scope; req.cwd itself is left
      // untouched for spawn and is added to the read scope by the generator.
      ...(readScoped
        ? { readOnlyPaths: canonicalize([...(req.readOnlyPaths ?? []), req.cwd]) }
        : {}),
    };
    const profile = generateSeatbeltProfile(resolved);
    const warnings: string[] = [];
    if (req.network === "allowlist") {
      warnings.push(
        "seatbelt cannot enforce domain allowlists; network is open and domains must be enforced at the network layer",
      );
    }
    return {
      // Profile passed inline via -p: deterministic, no temp files.
      argv: ["sandbox-exec", "-p", profile, ...req.argv],
      env: req.env,
      backend: this.name,
      warnings,
    };
  }
}
