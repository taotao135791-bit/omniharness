import type { PolicyRule } from "@omniharness/shared-types";
import { describe, expect, it } from "vitest";
import type { StoredPolicyRule } from "./engine.js";
import {
  deserializeRules,
  ruleFromRow,
  ruleToRow,
  serializeRules,
  type PolicyRuleRow,
} from "./serialize.js";

describe("ruleToRow / ruleFromRow", () => {
  it("round-trips a rule with constraints", () => {
    const rule: PolicyRule = {
      capability: "network",
      decision: "allow_with_constraints",
      constraints: { domains: ["example.com"], maxFileSizeBytes: 1024 },
    };
    const row = ruleToRow("profile", "prof-1", rule);
    expect(row.scope).toBe("profile");
    expect(row.scopeId).toBe("prof-1");
    expect(row.constraints).toBe(JSON.stringify(rule.constraints));

    const parsed = ruleFromRow(row);
    expect(parsed.scope).toBe("profile");
    expect(parsed.scopeId).toBe("prof-1");
    expect(parsed.rule).toEqual(rule);
  });

  it("round-trips a rule without constraints (null column)", () => {
    const rule: PolicyRule = { capability: "secret.read", decision: "deny" };
    const row = ruleToRow("product_default", null, rule);
    expect(row.constraints).toBeNull();

    const parsed = ruleFromRow(row);
    expect(parsed.rule).toEqual(rule);
    expect(parsed.rule.constraints).toBeUndefined();
  });

  it("rejects unknown scope, capability, and decision", () => {
    const base: PolicyRuleRow = {
      scope: "tool",
      scopeId: "fs",
      capability: "fs.read",
      decision: "deny",
      constraints: null,
    };
    expect(() => ruleFromRow({ ...base, scope: "galaxy" })).toThrow(/scope/);
    expect(() =>
      ruleFromRow({ ...base, capability: "teleport" as PolicyRuleRow["capability"] }),
    ).toThrow(/capability/);
    expect(() =>
      ruleFromRow({ ...base, decision: "maybe" as PolicyRuleRow["decision"] }),
    ).toThrow(/decision/);
  });

  it("rejects malformed constraints JSON", () => {
    const base: PolicyRuleRow = {
      scope: "tool",
      scopeId: "fs",
      capability: "fs.read",
      decision: "deny",
      constraints: null,
    };
    expect(() => ruleFromRow({ ...base, constraints: "[1,2]" })).toThrow(/constraints/);
    expect(() =>
      ruleFromRow({ ...base, constraints: JSON.stringify({ pathGlobs: [1, 2] }) }),
    ).toThrow(/pathGlobs/);
    expect(() =>
      ruleFromRow({ ...base, constraints: JSON.stringify({ maxFileSizeBytes: "big" }) }),
    ).toThrow(/maxFileSizeBytes/);
    expect(() => ruleFromRow({ ...base, constraints: "{not json" })).toThrow();
  });
});

describe("serializeRules / deserializeRules", () => {
  it("round-trips an array of stored rules", () => {
    const rules: StoredPolicyRule[] = [
      { scope: "tool", scopeId: "fs", rule: { capability: "fs.read", decision: "always_allow" } },
      {
        scope: "workspace",
        scopeId: "ws-1",
        rule: {
          capability: "fs.write",
          decision: "allow_with_constraints",
          constraints: { pathGlobs: ["/work/**"], commandPatterns: ["npm *"] },
        },
      },
      { scope: "product_default", scopeId: null, rule: { capability: "browser", decision: "ask_every_time" } },
    ];
    const rows = serializeRules(rules);
    expect(rows).toHaveLength(3);
    expect(deserializeRules(rows)).toEqual(rules);
  });

  it("deserializeRules rejects an array containing an invalid row", () => {
    const rows: PolicyRuleRow[] = [
      { scope: "tool", scopeId: "fs", capability: "fs.read", decision: "deny", constraints: null },
      {
        scope: "tool",
        scopeId: "fs",
        capability: "nope" as PolicyRuleRow["capability"],
        decision: "deny",
        constraints: null,
      },
    ];
    expect(() => deserializeRules(rows)).toThrow(/capability/);
  });
});
