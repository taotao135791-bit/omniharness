import { PolicyEngine } from "@omniharness/policy-engine";
import type { PolicyEvaluationContext } from "@omniharness/shared-types";
import type { PolicyGate } from "./types.js";

/**
 * Adapts the workspace PolicyEngine to the browser runtime's PolicyGate:
 * evaluates the "browser" capability with the target domain; anything other
 * than an explicit "deny" allows navigation (ask_* decisions are resolved
 * upstream, the gate itself only answers yes/no).
 */
export function policyEngineGate(
  engine: PolicyEngine,
  context: Partial<PolicyEvaluationContext> = {},
): PolicyGate {
  return {
    check(domain: string): Promise<boolean> {
      const evaluation = engine.evaluate({
        capability: "browser",
        toolName: "browser-runtime",
        target: domain,
        ...context,
      });
      return Promise.resolve(evaluation.decision !== "deny");
    },
  };
}

/** Gate backed by a static domain allowlist (exact or *.suffix matches). */
export function allowlistGate(domains: readonly string[]): PolicyGate {
  return {
    check(domain: string): Promise<boolean> {
      const lower = domain.toLowerCase();
      const allowed = domains.some((entry) => {
        const e = entry.toLowerCase();
        return lower === e || (e.startsWith("*.") && lower.endsWith(e.slice(1)));
      });
      return Promise.resolve(allowed);
    },
  };
}
