import type { MemoryEntry, MemoryId, ProfileId, ProjectId } from "@omniharness/shared-types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type OmniDatabase } from "../src/index.js";
import { seedBase, tick } from "./testkit.js";

let db: OmniDatabase;
let profileId: ProfileId;
let projectId: ProjectId;

beforeEach(() => {
  db = openDatabase(":memory:");
  const base = seedBase(db);
  profileId = base.profileId;
  projectId = base.projectId;
});

afterEach(() => {
  db.close();
});

let memCounter = 0;
function memory(partial: Partial<MemoryEntry> & { summary: string; content: string }): MemoryEntry {
  memCounter += 1;
  return {
    id: `mem_${memCounter}` as MemoryId,
    kind: "semantic",
    profileId,
    projectId,
    sourceSessionId: null,
    createdBy: "agent",
    createdAt: tick(),
    lastVerifiedAt: tick(),
    confidence: 0.9,
    scope: { profileId, projectId },
    approvedByUser: true,
    evidenceRefs: [],
    sensitivity: "normal",
    expiresAt: null,
    archived: false,
    ...partial,
  };
}

describe("memories with FTS5", () => {
  it("returns ranked full-text search results", () => {
    db.memories.put(
      memory({
        summary: "TypeScript config conventions",
        content: "TypeScript projects here use strict mode. TypeScript everywhere.",
      }),
    );
    db.memories.put(
      memory({
        summary: "Deployment",
        content: "Deploys go through a TypeScript wrapper script.",
      }),
    );
    db.memories.put(memory({ summary: "Coffee", content: "Team prefers light roast." }));

    const results = db.memories.search({ text: "TypeScript", profileId });
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.entry.summary)).not.toContain("Coffee");
    // bm25 ranks the term-dense entry first
    expect(results[0]?.entry.summary).toBe("TypeScript config conventions");
    expect(results[0]?.score).toBeGreaterThan(results[1]?.score ?? 0);
  });

  it("keeps the FTS index in sync on update and delete (via triggers)", () => {
    const entry = memory({ summary: "alpha keyword", content: "original body" });
    db.memories.put(entry);
    expect(db.memories.search({ text: "alpha", profileId })).toHaveLength(1);

    db.memories.put({ ...entry, summary: "beta keyword", content: "rewritten body" });
    expect(db.memories.search({ text: "alpha", profileId })).toHaveLength(0);
    expect(db.memories.search({ text: "beta", profileId })).toHaveLength(1);

    db.memories.delete(entry.id);
    expect(db.memories.search({ text: "beta", profileId })).toHaveLength(0);
  });

  it("respects approval, kind, project and archived filters", () => {
    db.memories.put(
      memory({ summary: "approved fact", content: "visible fact", approvedByUser: true }),
    );
    db.memories.put(
      memory({
        summary: "pending proposal",
        content: "pending fact",
        createdBy: "agent",
        approvedByUser: false,
      }),
    );
    db.memories.put(
      memory({ summary: "episodic note", content: "visible episode", kind: "episodic" }),
    );
    db.memories.put(
      memory({ summary: "archived fact", content: "visible archive", archived: true }),
    );

    // default: pending agent proposals are hidden
    const def = db.memories.search({ text: "visible OR pending", profileId });
    expect(def.map((r) => r.entry.summary)).toContain("approved fact");
    expect(def.map((r) => r.entry.summary)).not.toContain("pending proposal");
    expect(def.map((r) => r.entry.summary)).not.toContain("archived fact");

    // includePending surfaces the proposal
    const withPending = db.memories.search({
      text: "pending",
      profileId,
      includePending: true,
    });
    expect(withPending).toHaveLength(1);

    // kind filter
    const episodic = db.memories.search({ text: "visible", profileId, kinds: ["episodic"] });
    expect(episodic.map((r) => r.entry.summary)).toEqual(["episodic note"]);

    // approvedOnly
    const approved = db.memories.search({
      text: "visible OR pending",
      profileId,
      approvedOnly: true,
    });
    expect(approved.every((r) => r.entry.approvedByUser)).toBe(true);
  });
});

describe("settings scoping", () => {
  it("isolates values by scope and scopeId", () => {
    db.settings.set("global", "", "theme", "dark");
    db.settings.set("profile", "prof_1", "theme", "light");
    db.settings.set("profile", "prof_2", "theme", "solarized");
    db.settings.set("project", "proj_1", "build.cmd", ["pnpm", "build"]);

    expect(db.settings.get("global", "", "theme")).toBe("dark");
    expect(db.settings.get("profile", "prof_1", "theme")).toBe("light");
    expect(db.settings.get("profile", "prof_2", "theme")).toBe("solarized");
    expect(db.settings.getAs<string[]>("project", "proj_1", "build.cmd")).toEqual([
      "pnpm",
      "build",
    ]);
    expect(db.settings.get("profile", "prof_1", "missing")).toBeUndefined();

    // overwrite
    db.settings.set("global", "", "theme", "auto");
    expect(db.settings.get("global", "", "theme")).toBe("auto");

    // list is scoped
    const profSettings = db.settings.list("profile", "prof_1");
    expect(profSettings).toHaveLength(1);
    expect(profSettings[0]?.key).toBe("theme");

    // delete only the targeted scope entry
    expect(db.settings.delete("profile", "prof_1", "theme")).toBe(true);
    expect(db.settings.get("profile", "prof_1", "theme")).toBeUndefined();
    expect(db.settings.get("profile", "prof_2", "theme")).toBe("solarized");
    expect(db.settings.delete("profile", "prof_1", "theme")).toBe(false);
  });
});
