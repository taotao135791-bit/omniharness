import { describe, expect, it } from "vitest";
import { SkillEngine, diffBodies } from "./engine.js";
import { InMemorySkillStore } from "./store.js";

function makeEngine(): SkillEngine {
  return new SkillEngine(new InMemorySkillStore());
}

const SESSION = {
  sessionId: "ses_1",
  summary: "Recovered a broken git checkout. Used git worktree to repair it safely.",
  suggestedName: "git-recovery",
};

describe("learning loop", () => {
  it("propose → test → approve → installed (disabled until explicitly enabled)", async () => {
    const engine = makeEngine();
    const proposal = await engine.proposeFromSession(SESSION);
    expect(proposal.status).toBe("pending");
    expect(proposal.skill.name).toBe("git-recovery");
    expect(proposal.skill.source).toBe("learned");
    expect(proposal.skill.enabled).toBe(false);
    expect(proposal.skill.body).toContain("# git-recovery");
    expect(proposal.diff).toBeNull();
    expect(proposal.basedOnSessionId).toBe("ses_1");

    const tested = await engine.testProposal(proposal.id, (skill) => ({
      passed: skill.body.length > 0,
      output: "dry run ok",
    }));
    expect(tested.status).toBe("pending");
    expect(tested.testResult).toEqual({ passed: true, output: "dry run ok" });

    const installed = await engine.approveProposal(proposal.id);
    expect(installed.source).toBe("learned");
    // Proposals never auto-activate.
    expect(installed.enabled).toBe(false);
    const stored = await engine.get(installed.id);
    expect(stored?.enabled).toBe(false);
    await engine.enable(installed.id);
    expect((await engine.get(installed.id))?.enabled).toBe(true);

    const proposals = await engine.listProposals();
    expect(proposals.find((p) => p.id === proposal.id)?.status).toBe("approved");
  });

  it("records a failing test result and still requires explicit approval", async () => {
    const engine = makeEngine();
    const proposal = await engine.proposeFromSession(SESSION);
    const tested = await engine.testProposal(proposal.id, () => {
      throw new Error("runner blew up");
    });
    expect(tested.testResult?.passed).toBe(false);
    expect(tested.testResult?.output).toContain("runner blew up");
    expect(tested.status).toBe("pending");
  });

  it("reject path: status rejected, reason kept, cannot approve after", async () => {
    const engine = makeEngine();
    const proposal = await engine.proposeFromSession(SESSION);
    const rejected = await engine.rejectProposal(proposal.id, "duplicates git-workflow");
    expect(rejected.status).toBe("rejected");
    expect(engine.rejectionReason(proposal.id)).toBe("duplicates git-workflow");
    await expect(engine.approveProposal(proposal.id)).rejects.toThrow(/rejected/);
    expect(await engine.list()).toHaveLength(0);
  });

  it("bumps version on update and keeps the old version in history", async () => {
    const engine = makeEngine();
    const first = await engine.proposeFromSession(SESSION);
    const v1 = await engine.approveProposal(first.id);
    expect(v1.version).toBe("0.1.0");

    const second = await engine.proposeFromSession({
      ...SESSION,
      summary: "Recovered a broken git checkout. Now also restores staged files.",
    });
    expect(second.diff).not.toBeNull();
    const v2 = await engine.approveProposal(second.id);
    expect(v2.id).toBe(v1.id);
    expect(v2.version).toBe("0.1.1");

    const history = await engine.listVersions(v1.id);
    const versions = history.map((h) => h.version);
    expect(versions).toContain("0.1.0");
    expect(versions[versions.length - 1]).toBe("0.1.0"); // snapshot before overwrite
    const current = await engine.get(v1.id);
    expect(current?.version).toBe("0.1.1");
    expect(current?.body).toContain("restores staged files");
  });

  it("derives a name when none is suggested", async () => {
    const engine = makeEngine();
    const proposal = await engine.proposeFromSession({
      sessionId: "ses_2",
      summary: "Optimized the database migration path for large tables.",
    });
    expect(proposal.skill.name).toMatch(/^learned-/);
  });

  it("rejects empty summaries", async () => {
    const engine = makeEngine();
    await expect(
      engine.proposeFromSession({ sessionId: "ses_3", summary: "   " }),
    ).rejects.toThrow(/must not be empty/);
  });
});

describe("diffBodies", () => {
  it("returns null for identical bodies", () => {
    expect(diffBodies("a\nb", "a\nb")).toBeNull();
  });

  it("marks changed middle lines", () => {
    const diff = diffBodies("same-top\nold-line\nsame-bottom", "same-top\nnew-line\nsame-bottom");
    expect(diff).toContain("- old-line");
    expect(diff).toContain("+ new-line");
    expect(diff).not.toContain("- same-top");
  });
});
