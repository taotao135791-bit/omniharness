import type { SkillDefinition, SkillId } from "@omniharness/shared-types";
import { describe, expect, it } from "vitest";
import { routeSkills } from "./routing.js";

function skill(partial: Partial<SkillDefinition> & { name: string }): SkillDefinition {
  return {
    id: `skl_${partial.name}` as SkillId,
    description: "",
    version: "1.0.0",
    body: "body",
    resources: [],
    requiredCapabilities: [],
    scope: "global",
    enabled: true,
    dependencies: [],
    source: "local",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

describe("routeSkills", () => {
  const installed = [
    skill({
      name: "code-review",
      description: "Review a diff for correctness, security and style issues.",
    }),
    skill({
      name: "git-workflow",
      description: "Safe git operations: branching, committing, worktrees.",
    }),
    skill({ name: "explain-code", description: "Explain unfamiliar code to the user." }),
  ];

  it("ranks an exact name match first", () => {
    const ranked = routeSkills("please do a code review of this diff", installed);
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0]?.skill.name).toBe("code-review");
  });

  it("ranks name-token overlap above description-only overlap", () => {
    const ranked = routeSkills("help me with this git workflow", installed);
    expect(ranked[0]?.skill.name).toBe("git-workflow");
    // "code" appears only in descriptions here, "git-workflow" matched by name tokens.
    for (const entry of ranked) {
      if (entry.skill.name !== "git-workflow") {
        expect(entry.score).toBeLessThan(ranked[0]?.score ?? 0);
      }
    }
  });

  it("returns empty when nothing matches", () => {
    expect(routeSkills("xyzzy plover", installed)).toEqual([]);
  });

  it("skips disabled skills", () => {
    const disabled = installed.map((s) => ({ ...s, enabled: false }));
    expect(routeSkills("code review", disabled)).toEqual([]);
  });

  it("is deterministic for ties (name order)", () => {
    const tied = [
      skill({ name: "b-skill", description: "deploy stuff" }),
      skill({ name: "a-skill", description: "deploy stuff" }),
    ];
    const ranked = routeSkills("deploy", tied);
    expect(ranked.map((r) => r.skill.name)).toEqual(["a-skill", "b-skill"]);
  });

  it("reports matched terms", () => {
    const ranked = routeSkills("review my code", installed);
    const top = ranked.find((r) => r.skill.name === "code-review");
    expect(top?.matchedTerms).toContain("review");
  });
});
