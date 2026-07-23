import type {
  Capability,
  PolicyDecisionKind,
  PolicyRule,
} from "@omniharness/shared-types";
import { ALL_CAPABILITIES } from "@omniharness/shared-types";
import type { RuleScopeKind, StoredPolicyRule } from "./engine.js";

/** Row shape used by the daemon to persist rules as JSON. */
export interface PolicyRuleRow {
  scope: string;
  scopeId: string | null;
  capability: Capability;
  decision: PolicyDecisionKind;
  /** JSON-serialized constraints, or null. */
  constraints: string | null;
}

const RULE_SCOPES: readonly RuleScopeKind[] = [
  "automation",
  "tool",
  "agent",
  "project",
  "workspace",
  "profile",
  "product_default",
];

const DECISION_KINDS: readonly PolicyDecisionKind[] = [
  "deny",
  "ask_every_time",
  "ask_once_per_session",
  "allow_for_workspace",
  "allow_with_constraints",
  "always_allow",
];

export function ruleToRow(
  scope: RuleScopeKind,
  scopeId: string | null,
  rule: PolicyRule,
): PolicyRuleRow {
  return {
    scope,
    scopeId,
    capability: rule.capability,
    decision: rule.decision,
    constraints: rule.constraints !== undefined ? JSON.stringify(rule.constraints) : null,
  };
}

function asScope(scope: string): RuleScopeKind {
  if ((RULE_SCOPES as readonly string[]).includes(scope)) {
    return scope as RuleScopeKind;
  }
  throw new Error(`Unknown policy rule scope: ${JSON.stringify(scope)}`);
}

function asStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`Invalid constraints.${field}: expected an array of strings`);
  }
  return [...value];
}

function parseConstraints(raw: string): NonNullable<PolicyRule["constraints"]> {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid constraints: expected a JSON object");
  }
  const record = value as Record<string, unknown>;
  const out: {
    pathGlobs?: string[];
    domains?: string[];
    commandPatterns?: string[];
    maxFileSizeBytes?: number;
  } = {};
  if (record.pathGlobs !== undefined) {
    out.pathGlobs = asStringArray(record.pathGlobs, "pathGlobs");
  }
  if (record.domains !== undefined) {
    out.domains = asStringArray(record.domains, "domains");
  }
  if (record.commandPatterns !== undefined) {
    out.commandPatterns = asStringArray(record.commandPatterns, "commandPatterns");
  }
  if (record.maxFileSizeBytes !== undefined) {
    if (typeof record.maxFileSizeBytes !== "number" || !Number.isFinite(record.maxFileSizeBytes)) {
      throw new Error("Invalid constraints.maxFileSizeBytes: expected a finite number");
    }
    out.maxFileSizeBytes = record.maxFileSizeBytes;
  }
  return out;
}

/** Parses and validates a persisted row; throws on unknown scope/capability/decision or malformed constraints. */
export function ruleFromRow(row: PolicyRuleRow): StoredPolicyRule {
  const scope = asScope(row.scope);
  if (!ALL_CAPABILITIES.includes(row.capability)) {
    throw new Error(`Unknown capability: ${JSON.stringify(row.capability)}`);
  }
  if (!DECISION_KINDS.includes(row.decision)) {
    throw new Error(`Unknown policy decision: ${JSON.stringify(row.decision)}`);
  }
  const constraints = row.constraints !== null ? parseConstraints(row.constraints) : undefined;
  return {
    scope,
    scopeId: row.scopeId,
    rule:
      constraints !== undefined
        ? { capability: row.capability, decision: row.decision, constraints }
        : { capability: row.capability, decision: row.decision },
  };
}

export function serializeRules(rules: readonly StoredPolicyRule[]): PolicyRuleRow[] {
  return rules.map((stored) => ruleToRow(stored.scope, stored.scopeId, stored.rule));
}

export function deserializeRules(rows: readonly PolicyRuleRow[]): StoredPolicyRule[] {
  return rows.map(ruleFromRow);
}
