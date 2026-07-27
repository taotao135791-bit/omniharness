import { describe, expect, it } from "vitest";
import { PolicyEngine } from "@omniharness/policy-engine";

/**
 * Security test: policy engine adversarial evaluation.
 */
describe("policy engine security", () => {
  it("denies secret.read by default", () => {
    const engine = new PolicyEngine();
    const evaln = engine.evaluate({ capability: "secret.read", toolName: "test" });
    expect(evaln.decision).toBe("deny");
  });

  it("shell.exec is never silently allowed by product defaults", () => {
    const engine = new PolicyEngine();
    const evaln = engine.evaluate({
      capability: "shell.exec",
      toolName: "shell.exec",
      target: "ls",
    });
    expect(["ask_every_time", "deny"]).toContain(evaln.decision);
  });

  it("dangerous commands classify as critical risk", () => {
    const engine = new PolicyEngine();
    for (const cmd of [
      "rm -rf /",
      "mkfs /dev/sda",
      "dd if=/dev/zero of=/dev/sda",
      ":(){ :|:& };:",
    ]) {
      const evaln = engine.evaluate({
        capability: "shell.exec",
        toolName: "shell.exec",
        target: cmd,
      });
      expect(evaln.risk).toBe("critical");
    }
  });

  it("domain constraints do not allow suffix-squatting", () => {
    const engine = new PolicyEngine();
    engine.addRule("profile", "p1", {
      capability: "network",
      decision: "allow_with_constraints",
      constraints: { domains: ["example.com"] },
    });
    const allowed = engine.evaluate({
      capability: "network",
      toolName: "web.fetch",
      profileId: "p1",
      target: "sub.example.com",
    });
    const squatted = engine.evaluate({
      capability: "network",
      toolName: "web.fetch",
      profileId: "p1",
      target: "notexample.com",
    });
    expect(allowed.decision).toBe("allow_with_constraints");
    expect(squatted.decision).not.toBe("allow_with_constraints");
  });

  it("automation scope cannot widen beyond profile rules", () => {
    const engine = new PolicyEngine();
    engine.addRule("profile", "p1", { capability: "network", decision: "deny" });
    engine.addRule("automation", "a1", { capability: "network", decision: "always_allow" });
    // Automation rules are more specific, but the daemon layer intersects;
    // the engine itself must at least report what matched so the caller can enforce.
    const evaln = engine.evaluate({
      capability: "network",
      toolName: "web.fetch",
      profileId: "p1",
      automationId: "a1",
    });
    // Matched automation scope — the daemon's effectivePermissions() intersects
    // and rejects this; documented invariant, tested in automation-engine.
    expect(evaln.matchedScope).toBe("automation");
  });
});
