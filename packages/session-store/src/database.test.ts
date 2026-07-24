import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventSeq } from "@omniharness/shared-types";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/index.js";
import { SCHEMA_V1_TABLES } from "../src/schema.js";
import { seedBase, tick } from "./testkit.js";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function tmpdirPath(): string {
  const d = mkdtempSync(join(tmpdir(), "omni-db-"));
  dirs.push(d);
  return d;
}

describe("event log", () => {
  it("assigns monotonically increasing seqs and supports since()", () => {
    const db = openDatabase(":memory:");
    const s1 = db.events.append("session.created", { id: "a" });
    const s2 = db.events.append("message.added", { id: "b" });
    const s3 = db.events.append("session.archived", { id: "a" });
    expect(s2).toBeGreaterThan(s1);
    expect(s3).toBeGreaterThan(s2);

    const all = db.events.since(0);
    expect(all.map((e) => e.seq)).toEqual([s1, s2, s3]);
    expect(all[0]?.payload).toEqual({ id: "a" });

    const afterFirst = db.events.since(s1);
    expect(afterFirst.map((e) => e.seq)).toEqual([s2, s3]);

    expect(db.events.since(s1, 1)).toHaveLength(1);
    expect(db.events.latestSeq()).toBe(s3);
    expect(db.events.count()).toBe(3);
    db.close();
  });

  it("keeps seq monotonic across close/reopen", () => {
    const path = join(tmpdirPath(), "events.sqlite");
    const first = openDatabase(path);
    const last = first.events.append("a", 1);
    first.events.append("b", 2);
    first.close();

    const second = openDatabase(path);
    expect(second.events.latestSeq()).toBe(2 as EventSeq);
    const next = second.events.append("c", 3);
    expect(next).toBeGreaterThan(last);
    expect(second.events.since(last).map((e) => e.payload)).toEqual([2, 3]);
    second.close();
  });
});

describe("database utilities", () => {
  it("passes integrity_check", () => {
    const db = openDatabase(":memory:");
    expect(db.integrityCheck()).toEqual(["ok"]);
    db.close();
  });

  it("creates a backup that opens and contains the data", async () => {
    const dir = tmpdirPath();
    const source = openDatabase(join(dir, "source.sqlite"));
    seedBase(source);
    source.events.append("before-backup", { n: 1 });
    const pages = await source.backup(join(dir, "backup.sqlite"));
    expect(pages).toBeGreaterThan(0);
    source.close();

    const copy = openDatabase(join(dir, "backup.sqlite"));
    expect(copy.schemaVersion()).toBe(1);
    expect(copy.profiles.list()).toHaveLength(1);
    expect(copy.events.count()).toBe(1);
    copy.close();
  });

  it("exports every table to JSON files", () => {
    const db = openDatabase(":memory:");
    const base = seedBase(db);
    db.events.append("x", {});
    const outDir = join(tmpdirPath(), "export");
    const written = db.exportAll(outDir);

    // every schema table (plus schema_migrations) gets a file
    for (const table of SCHEMA_V1_TABLES) {
      expect(existsSync(join(outDir, `${table}.json`)), table).toBe(true);
    }
    expect(existsSync(join(outDir, "schema_migrations.json"))).toBe(true);
    expect(written.length).toBeGreaterThanOrEqual(SCHEMA_V1_TABLES.length);

    const profiles = JSON.parse(readFileSync(join(outDir, "profiles.json"), "utf8")) as Array<{
      id: string;
    }>;
    expect(profiles[0]?.id).toBe(base.profileId);
    db.close();
  });

  it("runs multi-repo writes atomically inside transaction()", () => {
    const db = openDatabase(":memory:");
    const base = seedBase(db);
    expect(() =>
      db.transaction(() => {
        db.projects.put({ id: "proj_tx" as never, name: "tx", createdAt: tick() });
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(db.projects.get("proj_tx" as never)).toBeUndefined();

    db.transaction(() => {
      db.projects.put({ id: "proj_tx" as never, name: "tx", createdAt: tick() });
      db.events.append("tx.done", { session: base.sessionId });
    });
    expect(db.projects.get("proj_tx" as never)?.name).toBe("tx");
    db.close();
  });
});
