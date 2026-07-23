import type { Capability, RiskLevel } from "@omniharness/shared-types";

/**
 * Shell commands matching any of these patterns are treated as critical risk:
 * filesystem-wide deletion, disk formatting, raw disk writes, fork bombs,
 * and permission wreckage.
 */
export const DANGEROUS_COMMAND_PATTERNS: readonly RegExp[] = [
  // rm -rf / (also -fr, and `/*`), but not nested paths like /tmp/x
  /\brm\s+-\w*[rf]\w*\s+\/(?:\s|\*|$)/,
  // rm -rf ~ (home directory)
  /\brm\s+-\w*[rf]\w*\s+~/,
  // mkfs / mkfs.ext4 ...
  /\bmkfs(?:\.\w+)?\b/,
  // dd writing to a raw device: dd if=... of=/dev/sda
  /\bdd\b[^;|&]*\bof=\/dev\//,
  // classic fork bomb: :(){ :|:& };:
  /:\(\)\s*\{\s*:\|:&\s*\}\s*;\s*:/,
  // chmod -R 777 /
  /\bchmod\s+(?:-\w+\s+)*777\s+\/(?:\s|$)/,
  // shell redirection onto a raw disk device: > /dev/sda
  />\s*\/dev\/(?:sd|vd|nvme|hd)/,
];

/**
 * Deterministic risk classification per capability.
 *
 * Mapping rationale:
 * - critical: irreversible or externally visible actions (payments, system
 *   settings, secret disclosure, sending messages as the user).
 * - high: destructive or hard-to-reverse local actions (shell exec, deletes,
 *   pushes to shared remotes, software installs, filesystem access outside
 *   the workspace).
 * - medium: privacy- or exposure-relevant but recoverable (network, browser,
 *   computer use, clipboard, camera, microphone, notifications).
 * - low: plain workspace file reads/writes — kept low even without workspace
 *   context, per spec (simplicity and determinism over context sensitivity).
 *
 * shell.exec escalates high → critical when the command matches
 * DANGEROUS_COMMAND_PATTERNS.
 */
export function classifyRisk(capability: Capability, target?: string): RiskLevel {
  switch (capability) {
    case "payment":
    case "system.settings":
    case "secret.read":
    case "message.send":
      return "critical";
    case "shell.exec":
      if (target !== undefined && DANGEROUS_COMMAND_PATTERNS.some((p) => p.test(target))) {
        return "critical";
      }
      return "high";
    case "fs.delete":
    case "git.push":
    case "software.install":
    case "fs.outsideWorkspace":
      return "high";
    case "network":
    case "browser":
    case "computerUse":
    case "clipboard":
    case "camera":
    case "microphone":
    case "notification":
      return "medium";
    case "fs.read":
    case "fs.write":
      return "low";
  }
}
