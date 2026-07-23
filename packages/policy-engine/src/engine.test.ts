import type { PolicyEvaluationContext, PolicyRule } from "@omniharness/shared-types";
import { describe, expect, it } from "vitest";
import { PolicyEngine } from "./engine.js";

const WORKSPACE = "/work/repo";

function ctx(partial: Partial<PolicyEvaluationContext> & Pick<PolicyEvaluationContext, "capability">): PolicyEvaluationContext {
  return { toolName: "fs", ...partial };
}

describe("PolicyEngine scope precedence", () => {
  it("walks automation → tool → agent → project → workspace → profile → product_default", () => {
    const engine = new PolicyEngine();
    const full = ctx({
      capability: "shell.exec",
      automationId: "auto-1",
      agentId: "agent-1",
      projectId: "proj-1",
      workspaceId: "ws-1",
      profileId: "prof-1",
      target: "make build",
    });

    engine.addRule("profile", "prof-1", { capability: "shell.exec", decision: "allow_for_workspace" });
    expect(engine.evaluate(full).matchedScope).toBe("profile");

    engine.addRule("workspace", "ws-1", { capability: "shell.exec", decision: "ask_once_per_session" });
    expect(engine.evaluate(full).matchedScope).toBe("workspace");

    engine.addRule("project", "proj-1", { capability: "shell.exec", decision: "deny" });
    const evaluated = engine.evaluate(full);
    expect(evaluated.matchedScope).toBe("project");
    expect(evaluated.decision).toBe("deny");

    engine.addRule("agent", "agent-1", { capability: "shell.exec", decision: "always_allow" });
    expect(engine.evaluate(full).matchedScope).toBe("agent");

    engine.addRule("tool", "fs", { capability: "shell.exec", decision: "ask_every_time" });
    expect(engine.evaluate(full).matchedScope).toBe("tool");

    engine.addRule("automation", "auto-1", { capability: "shell.exec", decision: "always_allow" });
    expect(engine.evaluate(full).matchedScope).toBe("automation");
  });

  it("skips scopes whose id is absent from the context", () => {
    const engine = new PolicyEngine();
    engine.addRule("project", "proj-1", { capability: "network", decision: "deny" });
    const evaluated = engine.evaluate(ctx({ capability: "network", target: "api.example.com" }));
    expect(evaluated.matchedScope).toBe("product_default");
  });

  it("a user-added product_default rule beats the built-in default", () => {
    const engine = new PolicyEngine({ workspaceRoot: WORKSPACE });
    engine.addRule("product_default", { capability: "shell.exec", decision: "ask_once_per_session" });
    const evaluated = engine.evaluate(ctx({ capability: "shell.exec", target: "make build" }));
    expect(evaluated.matchedScope).toBe("product_default");
    expect(evaluated.decision).toBe("ask_once_per_session");
  });

  it("ignores rules for other capabilities", () => {
    const engine = new PolicyEngine();
    engine.addRule("tool", "fs", { capability: "fs.read", decision: "deny" });
    const evaluated = engine.evaluate(ctx({ capability: "fs.write", target: "/tmp/x" }));
    expect(evaluated.matchedScope).toBe("product_default");
  });

  it("a constrained rule does not match when the target is missing or fails constraints", () => {
    const engine = new PolicyEngine({ workspaceRoot: WORKSPACE });
    const rule: PolicyRule = {
      capability: "fs.write",
      decision: "always_allow",
      constraints: { pathGlobs: ["/work/repo/src/**"] },
    };
    engine.addRule("tool", "fs", rule);

    const noTarget = engine.evaluate(ctx({ capability: "fs.write" }));
    expect(noTarget.matchedScope).toBe("product_default");

    const outside = engine.evaluate(ctx({ capability: "fs.write", target: "/work/repo/docs/a.md" }));
    expect(outside.matchedScope).toBe("product_default");

    const inside = engine.evaluate(ctx({ capability: "fs.write", target: "/work/repo/src/a.ts" }));
    expect(inside.matchedScope).toBe("tool");
    expect(inside.decision).toBe("always_allow");
    expect(inside.constraints).toEqual({ pathGlobs: ["/work/repo/src/**"] });
  });
});

describe("PolicyEngine built-in defaults", () => {
  it("fs.write: always_allow inside the workspace, ask_every_time outside or unconfigured", () => {
    const engine = new PolicyEngine({ workspaceRoot: WORKSPACE });
    expect(
      engine.evaluate(ctx({ capability: "fs.write", target: "/work/repo/a.ts" })).decision,
    ).toBe("always_allow");
    expect(
      engine.evaluate(ctx({ capability: "fs.write", target: "/etc/hosts" })).decision,
    ).toBe("ask_every_time");

    const noWorkspace = new PolicyEngine();
    expect(
      noWorkspace.evaluate(ctx({ capability: "fs.write", target: "/work/repo/a.ts" })).decision,
    ).toBe("ask_every_time");
  });

  it("fs.read: always_allow inside, ask_once_per_session outside, deny when no workspace configured", () => {
    const engine = new PolicyEngine({ workspaceRoot: WORKSPACE });
    expect(
      engine.evaluate(ctx({ capability: "fs.read", target: "/work/repo/a.ts" })).decision,
    ).toBe("always_allow");
    expect(
      engine.evaluate(ctx({ capability: "fs.read", target: "/etc/passwd" })).decision,
    ).toBe("ask_once_per_session");

    const noWorkspace = new PolicyEngine();
    expect(
      noWorkspace.evaluate(ctx({ capability: "fs.read", target: "/etc/passwd" })).decision,
    ).toBe("deny");
  });

  it("shell.exec asks every time", () => {
    const engine = new PolicyEngine({ workspaceRoot: WORKSPACE });
    const evaluated = engine.evaluate(ctx({ capability: "shell.exec", target: "ls" }));
    expect(evaluated.decision).toBe("ask_every_time");
    expect(evaluated.matchedScope).toBe("product_default");
  });

  it("network asks every time, upgraded by the domain allowlist", () => {
    const engine = new PolicyEngine({ allowedDomains: ["example.com"] });
    const allowed = engine.evaluate(ctx({ capability: "network", target: "api.example.com" }));
    expect(allowed.decision).toBe("allow_with_constraints");
    expect(allowed.constraints).toEqual({ domains: ["example.com"] });

    const notListed = engine.evaluate(ctx({ capability: "network", target: "evil.io" }));
    expect(notListed.decision).toBe("ask_every_time");

    const lookalike = engine.evaluate(ctx({ capability: "network", target: "notexample.com" }));
    expect(lookalike.decision).toBe("ask_every_time");

    const noAllowlist = new PolicyEngine();
    expect(
      noAllowlist.evaluate(ctx({ capability: "network", target: "api.example.com" })).decision,
    ).toBe("ask_every_time");
  });

  it("secret.read is denied", () => {
    const engine = new PolicyEngine();
    expect(engine.evaluate(ctx({ capability: "secret.read", target: "AWS_KEY" })).decision).toBe(
      "deny",
    );
  });

  it("fs.delete, payment, message.send, git.push, system.settings, computerUse ask every time", () => {
    const engine = new PolicyEngine({ workspaceRoot: WORKSPACE });
    for (const capability of [
      "fs.delete",
      "payment",
      "message.send",
      "git.push",
      "system.settings",
      "computerUse",
      "browser",
    ] as const) {
      const evaluated = engine.evaluate(ctx({ capability, target: "something" }));
      expect(evaluated.decision).toBe("ask_every_time");
      expect(evaluated.matchedScope).toBe("product_default");
    }
  });

  it("includes risk and a human-readable reason in every evaluation", () => {
    const engine = new PolicyEngine({ workspaceRoot: WORKSPACE });
    const evaluated = engine.evaluate(ctx({ capability: "shell.exec", target: "rm -rf /" }));
    expect(evaluated.risk).toBe("critical");
    expect(evaluated.reason.length).toBeGreaterThan(0);

    const ruleEngine = new PolicyEngine();
    ruleEngine.addRule("tool", "fs", { capability: "payment", decision: "deny" });
    const fromRule = ruleEngine.evaluate(ctx({ capability: "payment", target: "$5" }));
    expect(fromRule.risk).toBe("critical");
    expect(fromRule.reason).toContain("tool");
  });
});

describe("PolicyEngine rule management", () => {
  it("addRule / listRules / removeRule / clearRules round-trip", () => {
    const engine = new PolicyEngine();
    const readRule: PolicyRule = { capability: "fs.read", decision: "always_allow" };
    const writeRule: PolicyRule = {
      capability: "fs.write",
      decision: "allow_with_constraints",
      constraints: { pathGlobs: ["/work/**"] },
    };
    engine.addRule("workspace", "ws-1", readRule);
    engine.addRule("workspace", "ws-1", writeRule);
    engine.addRule("product_default", { capability: "browser", decision: "deny" });

    expect(engine.listRules()).toHaveLength(3);
    expect(engine.listRules("workspace")).toHaveLength(2);
    expect(engine.listRules("workspace", "ws-1")).toHaveLength(2);
    expect(engine.listRules("workspace", "ws-2")).toHaveLength(0);
    expect(engine.listRules("product_default")).toHaveLength(1);

    expect(engine.removeRule("workspace", "ws-1", readRule)).toBe(true);
    expect(engine.removeRule("workspace", "ws-1", readRule)).toBe(false);
    expect(engine.listRules("workspace", "ws-1")).toHaveLength(1);

    engine.clearRules();
    expect(engine.listRules()).toHaveLength(0);
  });

  it("rejects malformed addRule calls", () => {
    const engine = new PolicyEngine();
    const rule: PolicyRule = { capability: "fs.read", decision: "deny" };
    expect(() =>
      (engine.addRule as (...args: unknown[]) => void)("tool", rule),
    ).toThrow(TypeError);
    expect(() =>
      (engine.addRule as (...args: unknown[]) => void)("product_default", "some-id", rule),
    ).toThrow(TypeError);
  });
});
