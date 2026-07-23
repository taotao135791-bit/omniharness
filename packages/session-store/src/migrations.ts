import type { DatabaseSync } from "node:sqlite";
import { nowIso } from "@omniharness/shared-types";
import { allRows, getRow, num, txt } from "./helpers.js";
import { SCHEMA_V1_DOWN_SQL, SCHEMA_V1_SQL } from "./schema.js";

/** A single ordered schema migration. `id` must be a positive, strictly increasing integer. */
export interface Migration {
  id: number;
  name: string;
  up(db: DatabaseSync): void;
  down(db: DatabaseSync): void;
}

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationError";
  }
}

interface MigrationRow {
  version: number;
  name: string;
  applied_at: string;
}

/** The built-in migration chain. Append new migrations here; never edit applied ones. */
export const MIGRATIONS: readonly Migration[] = [
  {
    id: 1,
    name: "schema_v1",
    up(db) {
      db.exec(SCHEMA_V1_SQL);
    },
    down(db) {
      db.exec(SCHEMA_V1_DOWN_SQL);
    },
  },
];

function ensureMigrationsTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
}

/** Highest applied migration version; 0 on a fresh database. */
export function currentVersion(db: DatabaseSync): number {
  ensureMigrationsTable(db);
  const row = getRow<{ v: number }>(
    db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations"),
  );
  return row ? num(row.v) : 0;
}

export function appliedMigrations(db: DatabaseSync): MigrationRow[] {
  ensureMigrationsTable(db);
  const rows = allRows<{ version: number; name: string; applied_at: string }>(
    db.prepare("SELECT version, name, applied_at FROM schema_migrations ORDER BY version"),
  );
  return rows.map((r) => ({ version: num(r.version), name: txt(r.name), applied_at: txt(r.applied_at) }));
}

function validateChain(migrations: readonly Migration[]): void {
  let prev = 0;
  for (const m of migrations) {
    if (!Number.isInteger(m.id) || m.id <= 0) {
      throw new MigrationError(`migration "${m.name}" has invalid id ${String(m.id)}`);
    }
    if (m.id <= prev) {
      throw new MigrationError(
        `migrations must have strictly increasing ids (got ${m.id} after ${prev})`,
      );
    }
    prev = m.id;
  }
}

/**
 * Migrate the database to `targetVersion` (default: the latest known migration),
 * applying each migration inside its own IMMEDIATE transaction.
 *
 * - Upgrade: applies every migration with id in (current, target].
 * - Rollback: applies `down` for every migration with id in (target, current], newest first.
 * - Refuses to open a database newer than the code (current > max known id).
 */
export function migrate(
  db: DatabaseSync,
  migrations: readonly Migration[] = MIGRATIONS,
  targetVersion?: number,
): number {
  validateChain(migrations);
  ensureMigrationsTable(db);

  const latest = migrations.length > 0 ? (migrations[migrations.length - 1]?.id ?? 0) : 0;
  const target = targetVersion ?? latest;
  const current = currentVersion(db);

  if (current > latest) {
    throw new MigrationError(
      `database schema version ${current} is newer than this build supports (${latest}); upgrade OmniHarness`,
    );
  }
  if (target < 0 || target > latest) {
    throw new MigrationError(`invalid target schema version ${target} (known range 0..${latest})`);
  }
  if (target === current) return current;

  const byId = new Map(migrations.map((m) => [m.id, m]));
  const record = db.prepare(
    "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
  );
  const unrecord = db.prepare("DELETE FROM schema_migrations WHERE version = ?");

  if (target > current) {
    for (const m of migrations) {
      if (m.id <= current || m.id > target) continue;
      db.exec("BEGIN IMMEDIATE");
      try {
        m.up(db);
        record.run(m.id, m.name, nowIso());
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw new MigrationError(
          `migration ${m.id} ("${m.name}") failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } else {
    for (let v = current; v > target; v--) {
      const m = byId.get(v);
      if (!m) {
        throw new MigrationError(
          `cannot roll back: migration ${v} is applied but unknown to this build`,
        );
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        m.down(db);
        unrecord.run(v);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw new MigrationError(
          `rollback of migration ${v} ("${m.name}") failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
  return currentVersion(db);
}
