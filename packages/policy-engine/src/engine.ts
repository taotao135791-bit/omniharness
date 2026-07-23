import type {
  PolicyEvaluation,
  PolicyEvaluationContext,
  PolicyRule,
  PolicyScope,
} from "@omniharness/shared-types";
import { productDefault } from "./defaults.js";
import { constraintsMatch } from "./match.js";
import { classifyRisk } from "./risk.js";

/** Scopes under which rules can be stored (one_time approvals are not rules). */
export type RuleScopeKind = Extract<
  PolicyScope["kind"],
  "automation" | "tool" | "agent" | "project" | "workspace" | "profile" | "product_default"
>;

/** Rule scopes that carry a scope id (all except product_default). */
export type ScopedRuleScopeKind = Exclude<RuleScopeKind, "product_default">;

export interface StoredPolicyRule {
  scope: RuleScopeKind;
  scopeId: string | null;
  rule: PolicyRule;
}

export interface PolicyEngineOptions {
  /** POSIX-style workspace root used for workspace-local default decisions. */
  workspaceRoot?: string;
  /** Domain allowlist upgrading matching network defaults to allow_with_constraints. */
  allowedDomains?: string[];
}

function rulesEqual(a: PolicyRule, b: PolicyRule): boolean {
  return (
    a.capability === b.capability &&
    a.decision === b.decision &&
    JSON.stringify(a.constraints ?? null) === JSON.stringify(b.constraints ?? null)
  );
}

/**
 * Pure, deterministic capability-based policy evaluation.
 * Rules are evaluated most-specific scope first; the first matching rule wins.
 * When nothing matches, built-in product defaults apply.
 */
export class PolicyEngine {
  private readonly rules: StoredPolicyRule[] = [];
  private readonly workspaceRoot: string | undefined;
  private readonly allowedDomains: readonly string[] | undefined;

  constructor(options: PolicyEngineOptions = {}) {
    this.workspaceRoot = options.workspaceRoot;
    this.allowedDomains = options.allowedDomains !== undefined ? [...options.allowedDomains] : undefined;
  }

  addRule(scope: "product_default", rule: PolicyRule): void;
  addRule(scope: ScopedRuleScopeKind, scopeId: string, rule: PolicyRule): void;
  addRule(scope: RuleScopeKind, scopeIdOrRule: string | PolicyRule, rule?: PolicyRule): void {
    if (scope === "product_default") {
      if (typeof scopeIdOrRule === "string") {
        throw new TypeError("product_default rules take no scopeId: addRule(scope, rule)");
      }
      this.rules.push({ scope, scopeId: null, rule: scopeIdOrRule });
      return;
    }
    if (typeof scopeIdOrRule !== "string" || rule === undefined) {
      throw new TypeError(`addRule for scope "${scope}" requires (scope, scopeId, rule)`);
    }
    this.rules.push({ scope, scopeId: scopeIdOrRule, rule });
  }

  /** Removes the first stored rule structurally equal to the given one. */
  removeRule(scope: "product_default", rule: PolicyRule): boolean;
  removeRule(scope: ScopedRuleScopeKind, scopeId: string, rule: PolicyRule): boolean;
  removeRule(scope: RuleScopeKind, scopeIdOrRule: string | PolicyRule, rule?: PolicyRule): boolean {
    let scopeId: string | null;
    let target: PolicyRule;
    if (scope === "product_default") {
      if (typeof scopeIdOrRule === "string") {
        throw new TypeError("product_default rules take no scopeId: removeRule(scope, rule)");
      }
      scopeId = null;
      target = scopeIdOrRule;
    } else {
      if (typeof scopeIdOrRule !== "string" || rule === undefined) {
        throw new TypeError(`removeRule for scope "${scope}" requires (scope, scopeId, rule)`);
      }
      scopeId = scopeIdOrRule;
      target = rule;
    }
    const index = this.rules.findIndex(
      (stored) =>
        stored.scope === scope && stored.scopeId === scopeId && rulesEqual(stored.rule, target),
    );
    if (index === -1) {
      return false;
    }
    this.rules.splice(index, 1);
    return true;
  }

  /** Lists stored rules, optionally filtered by scope and scope id. */
  listRules(scope?: RuleScopeKind, scopeId?: string): StoredPolicyRule[] {
    return this.rules
      .filter(
        (stored) =>
          (scope === undefined || stored.scope === scope) &&
          (scopeId === undefined || stored.scopeId === scopeId),
      )
      .map((stored) => ({
        scope: stored.scope,
        scopeId: stored.scopeId,
        rule: {
          capability: stored.rule.capability,
          decision: stored.rule.decision,
          ...(stored.rule.constraints !== undefined
            ? { constraints: { ...stored.rule.constraints } }
            : {}),
        },
      }));
  }

  clearRules(): void {
    this.rules.length = 0;
  }

  evaluate(ctx: PolicyEvaluationContext): PolicyEvaluation {
    const risk = classifyRisk(ctx.capability, ctx.target);

    const chain: ReadonlyArray<readonly [ScopedRuleScopeKind, string | undefined]> = [
      ["automation", ctx.automationId],
      ["tool", ctx.toolName],
      ["agent", ctx.agentId],
      ["project", ctx.projectId],
      ["workspace", ctx.workspaceId],
      ["profile", ctx.profileId],
    ];
    for (const [scope, scopeId] of chain) {
      if (scopeId === undefined) {
        continue;
      }
      const matched = this.findMatchingRule(scope, scopeId, ctx);
      if (matched !== undefined) {
        return this.evaluationFromRule(matched, scope, scopeId, ctx, risk);
      }
    }

    const productRule = this.findMatchingRule("product_default", null, ctx);
    if (productRule !== undefined) {
      return this.evaluationFromRule(productRule, "product_default", null, ctx, risk);
    }

    const fallback = productDefault(ctx, {
      workspaceRoot: this.workspaceRoot,
      allowedDomains: this.allowedDomains,
    });
    return {
      decision: fallback.decision,
      risk,
      matchedScope: "product_default",
      reason: fallback.reason,
      ...(fallback.constraints !== undefined ? { constraints: fallback.constraints } : {}),
    };
  }

  private findMatchingRule(
    scope: RuleScopeKind,
    scopeId: string | null,
    ctx: PolicyEvaluationContext,
  ): PolicyRule | undefined {
    for (const stored of this.rules) {
      if (stored.scope !== scope || stored.scopeId !== scopeId) {
        continue;
      }
      if (stored.rule.capability !== ctx.capability) {
        continue;
      }
      if (!constraintsMatch(stored.rule.constraints, ctx.capability, ctx.target)) {
        continue;
      }
      return stored.rule;
    }
    return undefined;
  }

  private evaluationFromRule(
    rule: PolicyRule,
    scope: RuleScopeKind,
    scopeId: string | null,
    ctx: PolicyEvaluationContext,
    risk: PolicyEvaluation["risk"],
  ): PolicyEvaluation {
    const scopeLabel = scopeId !== null ? `${scope} scope (${scopeId})` : `${scope} scope`;
    const targetLabel = ctx.target !== undefined ? ` for target "${ctx.target}"` : "";
    return {
      decision: rule.decision,
      risk,
      matchedScope: scope,
      reason: `Matched ${scopeLabel}: ${rule.decision} for ${rule.capability}${targetLabel}.`,
      ...(rule.constraints !== undefined ? { constraints: rule.constraints } : {}),
    };
  }
}
