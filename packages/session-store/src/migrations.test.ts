import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MIGRATIONS,
  MigrationError,
  appliedMigrations,
  currentVersion,
  migrate,
  openDatabase,
  type Migration,
} from "../src/index.js";

const FAKE_V2: Migration = {
  id: 2,
  name: "fake_v2",
  up(db) {
    db.exec("CREATE TABLE v2_marker (id TEXT PRIMARY KEY, note TEXT)");
  },
  down(db) {
    db.exec("DROP TABLE IF EXISTS v2_marker");
  },
};

const WITH_V2: readonly Migration[] = [...MIGRATIONS, FAKE_V2];

function tableExists(db: DatabaseSync, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
  return row !== undefined;
}

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("migrations", () => {
  it("migrates an empty in-memory database to v1", () => {
    const db = openDatabase(":memory:");
    expect(db.schemaVersion()).toBe(1);
    expect(tableExists(db.raw, "sessions")).toBe(true);
    expect(tableExists(db.raw, "event_log")).toBe(true);
    expect(tableExists(db.raw, "memories_fts")).toBe(true);
    expect(tableExists(db.raw, "schema_migrations")).toBe(true);
    const applied = appliedMigrations(db.raw);
    expect(applied).toHaveLength(1);
    expect(applied[0]?.name).toBe("schema_v1");
    db.close();
  });

  it("is idempotent on reopen of a migrated file", () => {
    const dir = mkdtempSync(join(tmpdir(), "omni-mig-"));
    dirs.push(dir);
    const path = join(dir, "db.sqlite");
    const first = openDatabase(path);
    first.close();
    const second = openDatabase(path);
    expect(second.schemaVersion()).toBe(1);
    expect(appliedMigrations(second.raw)).toHaveLength(1);
    second.close();
  });

  it("upgrades to a fake v2 and rolls back to v1, then to 0", () => {
    const db = openDatabase(":memory:", { migrations: WITH_V2 });
    expect(currentVersion(db.raw)).toBe(2);
    expect(tableExists(db.raw, "v2_marker")).toBe(true);

    const v = migrate(db.raw, WITH_V2, 1);
    expect(v).toBe(1);
    expect(tableExists(db.raw, "v2_marker")).toBe(false);
    expect(tableExists(db.raw, "sessions")).toBe(true);

    const v0 = migrate(db.raw, WITH_V2, 0);
    expect(v0).toBe(0);
    expect(tableExists(db.raw, "sessions")).toBe(false);
    db.close();
  });

  it("refuses to open a database newer than the code", () => {
    const dir = mkdtempSync(join(tmpdir(), "omni-mig-"));
    dirs.push(dir);
    const path = join(dir, "db.sqlite");
    const db = openDatabase(path, { migrations: WITH_V2 });
    expect(db.schemaVersion()).toBe(2);

    expect(() => migrate(db.raw, MIGRATIONS)).toThrow(MigrationError);
    db.close();

    expect(() => openDatabase(path)).toThrow(MigrationError);
  });

  it("rejects invalid targets and unordered chains", () => {
    const db = openDatabase(":memory:");
    expect(() => migrate(db.raw, MIGRATIONS, 99)).toThrow(MigrationError);
    expect(() => migrate(db.raw, MIGRATIONS, -1)).toThrow(MigrationError);
    const bad: readonly Migration[] = [
      { id: 2, name: "b", up() {}, down() {} },
      { id: 1, name: "a", up() {}, down() {} },
    ];
    expect(() => migrate(db.raw, bad)).toThrow(MigrationError);
    db.close();
  });

  it("rolls back a failed migration transactionally", () => {
    const broken: Migration = {
      id: 2,
      name: "broken",
      up(db) {
        db.exec("CREATE TABLE partial (id TEXT)");
        db.exec("INSERT INTO nonexistent VALUES (1)");
      },
      down() {},
    };
    const db = openDatabase(":memory:");
    expect(() => migrate(db.raw, [...MIGRATIONS, broken])).toThrow(MigrationError);
    expect(currentVersion(db.raw)).toBe(1);
    expect(tableExists(db.raw, "partial")).toBe(false);
    db.close();
  });
});
