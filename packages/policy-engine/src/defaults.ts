import type {
  PolicyDecisionKind,
  PolicyEvaluationContext,
  PolicyRule,
} from "@omniharness/shared-types";
import { matchDomain } from "./match.js";

export interface BuiltinDefaultsOptions {
  workspaceRoot: string | undefined;
  allowedDomains: readonly string[] | undefined;
}

export interface ProductDefaultResult {
  decision: PolicyDecisionKind;
  reason: string;
  constraints?: PolicyRule["constraints"];
}

/** POSIX-style check: target equals the root or lives under it. */
export function isInsideWorkspace(workspaceRoot: string, target: string): boolean {
  const root = workspaceRoot.endsWith("/") ? workspaceRoot.slice(0, -1) : workspaceRoot;
  return target === root || target.startsWith(`${root}/`);
}

/**
 * Built-in product defaults, applied when no user-added rule matches.
 * Results carry matchedScope "product_default" (added by the caller).
 */
export function productDefault(
  ctx: PolicyEvaluationContext,
  options: BuiltinDefaultsOptions,
): ProductDefaultResult {
  const { capability, target } = ctx;
  const { workspaceRoot, allowedDomains } = options;

  switch (capability) {
    case "fs.write": {
      if (workspaceRoot !== undefined && target !== undefined && isInsideWorkspace(workspaceRoot, target)) {
        return {
          decision: "always_allow",
          reason: `Product default: fs.write inside the workspace (${workspaceRoot}) is always allowed.`,
        };
      }
      return {
        decision: "ask_every_time",
        reason:
          workspaceRoot === undefined
            ? "Product default: no workspace configured; fs.write requires approval every time."
            : "Product default: fs.write outside the workspace requires approval every time.",
      };
    }
    case "fs.read": {
      if (workspaceRoot !== undefined && target !== undefined && isInsideWorkspace(workspaceRoot, target)) {
        return {
          decision: "always_allow",
          reason: `Product default: fs.read inside the workspace (${workspaceRoot}) is always allowed.`,
        };
      }
      if (workspaceRoot !== undefined) {
        return {
          decision: "ask_once_per_session",
          reason: "Product default: fs.read outside the workspace asks once per session.",
        };
      }
      return {
        decision: "deny",
        reason: "Product default: no workspace configured; fs.read outside the workspace is denied.",
      };
    }
    case "network": {
      if (
        allowedDomains !== undefined &&
        allowedDomains.length > 0 &&
        target !== undefined &&
        matchDomain(allowedDomains, target)
      ) {
        return {
          decision: "allow_with_constraints",
          reason: `Product default: network access to "${target}" is on the engine domain allowlist.`,
          constraints: { domains: [...allowedDomains] },
        };
      }
      return {
        decision: "ask_every_time",
        reason: "Product default: network access requires approval every time.",
      };
    }
    case "secret.read":
      return {
        decision: "deny",
        reason: "Product default: secret.read is always denied.",
      };
    default:
      // shell.exec, fs.delete, payment, message.send, git.push,
      // system.settings, computerUse, and every other capability.
      return {
        decision: "ask_every_time",
        reason: `Product default: ${capability} requires approval every time.`,
      };
  }
}
