import type { MemoryEntry, MemoryId, ProfileId, ProjectId } from "@omniharness/shared-types";
import { openDatabase, type OmniDatabase } from "@omniharness/session-store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryEngine, MAX_PROPOSED_CONFIDENCE } from "./index.js";
import type { ProfileMemoryExport } from "./index.js";

const NOW = new Date("2026-07-01T00:00:00.000Z");
const DAY_MS = 86_400_000;

const PROFILE_A = "prof_a" as ProfileId;
const PROFILE_B = "prof_b" as ProfileId;
const PROJECT_1 = "proj_1" as ProjectId;
const PROJECT_2 = "proj_2" as ProjectId;

function iso(daysBeforeNow: number): string {
  return new Date(NOW.getTime() - daysBeforeNow * DAY_MS).toISOString();
}

let db: OmniDatabase;
let engine: MemoryEngine;

beforeEach(() => {
  db = openDatabase(":memory:");
  engine = new MemoryEngine(db, { now: () => new Date(NOW.getTime()) });
});

afterEach(() => {
  db.close();
});

let counter = 0;
/** Craft an entry directly in the repo (for backdated/canned fixtures). */
function putEntry(
  partial: Partial<MemoryEntry> & { content: string; summary: string },
): MemoryEntry {
  counter += 1;
  const entry: MemoryEntry = {
    id: `mem_test_${counter}` as MemoryId,
    kind: "semantic",
    profileId: PROFILE_A,
    projectId: null,
    sourceSessionId: null,
    createdBy: "user",
    createdAt: NOW.toISOString(),
    lastVerifiedAt: NOW.toISOString(),
    confidence: 1,
    scope: { profileId: PROFILE_A, projectId: null },
    approvedByUser: true,
    evidenceRefs: [],
    sensitivity: "normal",
    expiresAt: null,
    archived: false,
    ...partial,
  };
  db.memories.put(entry);
  return entry;
}

describe("write path with provenance & approval", () => {
  it("propose creates a pending memory capped at 0.7 confidence; approve surfaces it", () => {
    const proposed = engine.propose({
      kind: "semantic",
      profileId: PROFILE_A,
      summary: "TypeScript strictness",
      content: "This repo uses TypeScript strict mode everywhere.",
      confidence: 0.95,
      evidenceRefs: ["msg_1"],
    });
    expect(proposed.createdBy).toBe("agent");
    expect(proposed.approvedByUser).toBe(false);
    expect(proposed.confidence).toBe(MAX_PROPOSED_CONFIDENCE);

    // Pending proposals are hidden by default, visible with includePending.
    expect(engine.search({ text: "TypeScript", profileId: PROFILE_A })).toHaveLength(0);
    expect(
      engine.search({ text: "TypeScript", profileId: PROFILE_A, includePending: true }),
    ).toHaveLength(1);

    expect(engine.approve(proposed.id)).toBe(true);
    const results = engine.search({ text: "TypeScript", profileId: PROFILE_A });
    expect(results).toHaveLength(1);
    expect(results[0]?.entry.approvedByUser).toBe(true);
  });

  it("propose requires evidence references", () => {
    expect(() =>
      engine.propose({
        kind: "episodic",
        profileId: PROFILE_A,
        summary: "no evidence",
        content: "unsupported claim",
        evidenceRefs: [],
      }),
    ).toThrow(/evidence/);
  });

  it("add creates an approved user memory with confidence 1.0", () => {
    const entry = engine.add({
      kind: "userPreference",
      profileId: PROFILE_A,
      summary: "Editor",
      content: "User prefers vim keybindings.",
    });
    expect(entry.createdBy).toBe("user");
    expect(entry.approvedByUser).toBe(true);
    expect(entry.confidence).toBe(1);
    expect(engine.search({ text: "vim", profileId: PROFILE_A })).toHaveLength(1);
  });

  it("rejected memory is archived and never surfaces, but keeps its trace", () => {
    const proposed = engine.propose({
      kind: "semantic",
      profileId: PROFILE_A,
      summary: "Rejected fact",
      content: "Something the user does not want remembered.",
      evidenceRefs: ["msg_9"],
    });
    expect(engine.reject(proposed.id)).toBe(true);

    expect(engine.search({ text: "remembered", profileId: PROFILE_A })).toHaveLength(0);
    expect(
      engine.search({ text: "remembered", profileId: PROFILE_A, includePending: true }),
    ).toHaveLength(0);
    const trace = engine.get(proposed.id);
    expect(trace).toBeDefined();
    expect(trace?.archived).toBe(true);
  });

  it("delete hard-deletes (user data rights)", () => {
    const entry = engine.add({
      kind: "userPreference",
      profileId: PROFILE_A,
      summary: "temp",
      content: "forget me entirely",
    });
    expect(engine.delete(entry.id)).toBe(true);
    expect(engine.get(entry.id)).toBeUndefined();
  });
});

describe("retrieval & scope isolation", () => {
  it("never leaks memories across profiles", () => {
    putEntry({ summary: "Alpha deploy", content: "kubernetes deploy runbook alpha" });
    putEntry({
      profileId: PROFILE_B,
      scope: { profileId: PROFILE_B, projectId: null },
      summary: "Beta deploy",
      content: "kubernetes deploy runbook beta",
    });

    const a = engine.search({ text: "kubernetes", profileId: PROFILE_A });
    expect(a).toHaveLength(1);
    expect(a[0]?.entry.profileId).toBe(PROFILE_A);

    const b = engine.search({ text: "kubernetes", profileId: PROFILE_B });
    expect(b).toHaveLength(1);
    expect(b[0]?.entry.profileId).toBe(PROFILE_B);
  });

  it("scopes project memories: matching project plus profile-wide only", () => {
    putEntry({
      projectId: PROJECT_1,
      scope: { profileId: PROFILE_A, projectId: PROJECT_1 },
      summary: "p1 deploy",
      content: "deploy notes for project one",
    });
    putEntry({
      projectId: PROJECT_2,
      scope: { profileId: PROFILE_A, projectId: PROJECT_2 },
      summary: "p2 deploy",
      content: "deploy notes for project two",
    });
    putEntry({ summary: "global deploy", content: "deploy notes for everything" });

    const results = engine.search({ text: "deploy", profileId: PROFILE_A, projectId: PROJECT_1 });
    const summaries = results.map((r) => r.entry.summary);
    expect(summaries).toContain("p1 deploy");
    expect(summaries).toContain("global deploy");
    expect(summaries).not.toContain("p2 deploy");
  });

  it("scores recent high-confidence above old low-confidence at equal FTS rank", () => {
    const recent = putEntry({
      summary: "alpha beta gamma",
      content: "alpha beta gamma",
      confidence: 1,
      lastVerifiedAt: iso(0),
    });
    const old = putEntry({
      summary: "alpha beta gamma",
      content: "alpha beta gamma",
      confidence: 0.4,
      lastVerifiedAt: iso(180),
    });

    const results = engine.search({ text: "alpha", profileId: PROFILE_A });
    expect(results).toHaveLength(2);
    expect(results[0]?.entry.id).toBe(recent.id);
    expect(results[0]?.score ?? 0).toBeGreaterThan(results[1]?.score ?? 0);
    expect(results[1]?.entry.id).toBe(old.id);
  });

  it("honors approvedOnly", () => {
    engine.propose({
      kind: "semantic",
      profileId: PROFILE_A,
      summary: "pending item",
      content: "pending quantum fact",
      evidenceRefs: ["msg_2"],
    });
    engine.add({
      kind: "semantic",
      profileId: PROFILE_A,
      summary: "approved item",
      content: "approved quantum fact",
    });
    const results = engine.search({ text: "quantum", profileId: PROFILE_A, approvedOnly: true });
    expect(results).toHaveLength(1);
    expect(results[0]?.entry.summary).toBe("approved item");
  });
});

describe("curate", () => {
  it("archives expired, stale, and duplicate entries — never deletes", () => {
    const expired = putEntry({ summary: "e", content: "expired fact", expiresAt: iso(1) });
    const stale = putEntry({
      summary: "s",
      content: "stale fact",
      lastVerifiedAt: iso(100),
    });
    const fresh = putEntry({ summary: "f", content: "fresh fact" });
    const dupKeep = putEntry({ summary: "dk", content: "same content", confidence: 0.9 });
    const dupDrop = putEntry({ summary: "dd", content: "same content", confidence: 0.4 });

    const report = engine.curate(new Date(NOW.getTime()));
    expect(report.expiredArchived).toEqual([expired.id]);
    expect(report.staleArchived).toEqual([stale.id]);
    expect(report.duplicatesArchived).toEqual([dupDrop.id]);

    for (const id of [expired.id, stale.id, dupDrop.id]) {
      const entry = engine.get(id);
      expect(entry?.archived).toBe(true);
    }
    expect(engine.get(fresh.id)?.archived).toBe(false);
    expect(engine.get(dupKeep.id)?.archived).toBe(false);

    // Idempotent: a second pass archives nothing new.
    const second = engine.curate(new Date(NOW.getTime()));
    expect(second.expiredArchived).toHaveLength(0);
    expect(second.staleArchived).toHaveLength(0);
    expect(second.duplicatesArchived).toHaveLength(0);
  });
});

describe("buildContextBlock", () => {
  it("includes approved memories, excludes pending and secret-adjacent", () => {
    engine.add({
      kind: "userPreference",
      profileId: PROFILE_A,
      summary: "Theme",
      content: "User likes dark mode.",
    });
    engine.propose({
      kind: "semantic",
      profileId: PROFILE_A,
      summary: "Pending",
      content: "UNAPPROVED pending claim",
      evidenceRefs: ["msg_3"],
    });
    engine.add({
      kind: "semantic",
      profileId: PROFILE_A,
      summary: "Keys",
      content: "SECRET neighbor wifi password hint",
      sensitivity: "secret-adjacent",
    });

    const block = engine.buildContextBlock(PROFILE_A, null);
    expect(block).toContain("## Long-term Memory");
    expect(block).toContain("dark mode");
    expect(block).not.toContain("UNAPPROVED");
    expect(block).not.toContain("SECRET");
  });

  it("returns empty string when nothing qualifies", () => {
    expect(engine.buildContextBlock(PROFILE_A, null, "nonexistent")).toBe("");
  });

  it("respects project scoping when queryText is given", () => {
    engine.add({
      kind: "project",
      profileId: PROFILE_A,
      projectId: PROJECT_1,
      summary: "p1",
      content: "deploy via docker compose",
    });
    engine.add({
      kind: "project",
      profileId: PROFILE_A,
      projectId: PROJECT_2,
      summary: "p2",
      content: "deploy via helm charts",
    });
    const block = engine.buildContextBlock(PROFILE_A, PROJECT_1, "deploy");
    expect(block).toContain("docker compose");
    expect(block).not.toContain("helm charts");
  });
});

describe("export/import", () => {
  it("round-trips a profile's memories with import provenance", () => {
    const first = engine.add({
      kind: "semantic",
      profileId: PROFILE_A,
      summary: "One",
      content: "first exported fact",
    });
    const second = engine.add({
      kind: "procedural",
      profileId: PROFILE_A,
      summary: "Two",
      content: "second exported fact",
    });
    engine.add({
      kind: "semantic",
      profileId: PROFILE_B,
      summary: "Other",
      content: "belongs to another profile",
    });

    const json = engine.exportProfile(PROFILE_A);
    const payload = JSON.parse(json) as ProfileMemoryExport;
    expect(payload.version).toBe(1);
    expect(payload.entries.map((e) => e.id).sort()).toEqual([first.id, second.id].sort());

    const targetDb = openDatabase(":memory:");
    try {
      const target = new MemoryEngine(targetDb, { now: () => new Date(NOW.getTime()) });
      const imported = target.importEntries(payload.entries, { source: "import" });
      expect(imported).toHaveLength(2);
      expect(imported.every((e) => e.createdBy === "import")).toBe(true);
      expect(imported.map((e) => e.id).sort()).toEqual([first.id, second.id].sort());

      const results = target.search({ text: "exported", profileId: PROFILE_A });
      expect(results).toHaveLength(2);

      // Re-export yields the same content set.
      const reexported = JSON.parse(target.exportProfile(PROFILE_A)) as ProfileMemoryExport;
      expect(reexported.entries.map((e) => e.content).sort()).toEqual(
        payload.entries.map((e) => e.content).sort(),
      );
    } finally {
      targetDb.close();
    }
  });

  it("assigns fresh ids on import when ids clash", () => {
    const entry = engine.add({
      kind: "semantic",
      profileId: PROFILE_A,
      summary: "clash",
      content: "existing content here",
    });
    const imported = engine.importEntries([entry], { source: "import" });
    expect(imported[0]?.id).not.toBe(entry.id);
    expect(imported[0]?.createdBy).toBe("import");
    expect(engine.search({ text: "existing", profileId: PROFILE_A })).toHaveLength(2);
  });
});
