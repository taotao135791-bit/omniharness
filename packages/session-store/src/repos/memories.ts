import type { DatabaseSync } from "node:sqlite";
import type {
  MemoryEntry,
  MemoryId,
  MemoryKind,
  MemoryQuery,
  MemorySearchResult,
  ProfileId,
  ProjectId,
  SessionId,
} from "@omniharness/shared-types";
import { allRows, bit, bool, getRow, jparse, jstr, num } from "../helpers.js";

interface MemoryRow {
  id: string;
  kind: string;
  profile_id: string;
  project_id: string | null;
  content: string;
  summary: string;
  source_session_id: string | null;
  created_by: string;
  created_at: string;
  last_verified_at: string;
  confidence: number;
  scope: string;
  approved_by_user: number;
  evidence_refs: string;
  sensitivity: string;
  expires_at: string | null;
  archived: number;
}

function rowToMemory(r: MemoryRow): MemoryEntry {
  return {
    id: r.id as MemoryId,
    kind: r.kind as MemoryKind,
    profileId: r.profile_id as ProfileId,
    projectId: r.project_id as ProjectId | null,
    content: r.content,
    summary: r.summary,
    sourceSessionId: r.source_session_id as SessionId | null,
    createdBy: r.created_by as MemoryEntry["createdBy"],
    createdAt: r.created_at,
    lastVerifiedAt: r.last_verified_at,
    confidence: num(r.confidence),
    scope: jparse<MemoryEntry["scope"]>(r.scope, {
      profileId: r.profile_id as ProfileId,
      projectId: null,
    }),
    approvedByUser: bool(r.approved_by_user),
    evidenceRefs: jparse<string[]>(r.evidence_refs, []),
    sensitivity: r.sensitivity as MemoryEntry["sensitivity"],
    expiresAt: r.expires_at,
    archived: bool(r.archived),
  };
}

/**
 * Memories with FTS5 full-text search over summary+content. The memories_fts
 * virtual table is an external-content index kept in sync by the memories_ai /
 * memories_ad / memories_au triggers installed by migration 1.
 */
export class MemoriesRepo {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  put(entry: MemoryEntry): void {
    this.db
      .prepare(
        `INSERT INTO memories
           (id, kind, profile_id, project_id, content, summary, source_session_id, created_by,
            created_at, last_verified_at, confidence, scope, approved_by_user, evidence_refs,
            sensitivity, expires_at, archived)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           kind = excluded.kind, profile_id = excluded.profile_id, project_id = excluded.project_id,
           content = excluded.content, summary = excluded.summary,
           source_session_id = excluded.source_session_id, created_by = excluded.created_by,
           last_verified_at = excluded.last_verified_at, confidence = excluded.confidence,
           scope = excluded.scope, approved_by_user = excluded.approved_by_user,
           evidence_refs = excluded.evidence_refs, sensitivity = excluded.sensitivity,
           expires_at = excluded.expires_at, archived = excluded.archived`,
      )
      .run(
        entry.id,
        entry.kind,
        entry.profileId,
        entry.projectId,
        entry.content,
        entry.summary,
        entry.sourceSessionId,
        entry.createdBy,
        entry.createdAt,
        entry.lastVerifiedAt,
        entry.confidence,
        jstr(entry.scope),
        bit(entry.approvedByUser),
        jstr(entry.evidenceRefs),
        entry.sensitivity,
        entry.expiresAt,
        bit(entry.archived),
      );
  }

  get(id: MemoryId): MemoryEntry | undefined {
    const row = getRow<MemoryRow>(this.db.prepare("SELECT * FROM memories WHERE id = ?"), id);
    return row === undefined ? undefined : rowToMemory(row);
  }

  listByProfile(profileId: ProfileId, kind?: MemoryKind, includeArchived = false): MemoryEntry[] {
    const where = ["profile_id = ?"];
    const params: string[] = [profileId];
    if (kind !== undefined) {
      where.push("kind = ?");
      params.push(kind);
    }
    if (!includeArchived) where.push("archived = 0");
    return allRows<MemoryRow>(
      this.db.prepare(
        `SELECT * FROM memories WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id`,
      ),
      ...params,
    ).map(rowToMemory);
  }

  /**
   * Full-text search over summary+content, ranked by bm25 (score negated so
   * higher = more relevant). `query.text` must be a valid FTS5 query string.
   */
  search(query: MemoryQuery): MemorySearchResult[] {
    const where = ["memories_fts MATCH ?", "m.profile_id = ?", "m.archived = 0"];
    const params: Array<string | number> = [query.text, query.profileId];
    if (query.kinds !== undefined && query.kinds.length > 0) {
      where.push(`m.kind IN (${query.kinds.map(() => "?").join(", ")})`);
      params.push(...query.kinds);
    }
    if (query.projectId !== undefined) {
      where.push("(m.project_id = ? OR m.project_id IS NULL)");
      params.push(query.projectId);
    }
    if (query.approvedOnly === true) where.push("m.approved_by_user = 1");
    if (query.includePending !== true && query.approvedOnly !== true) {
      // Default: approved or user-created only; pending agent proposals hidden.
      where.push("(m.approved_by_user = 1 OR m.created_by = 'user')");
    }
    const limit = query.limit ?? 20;
    interface SearchRow extends MemoryRow {
      score: number;
    }
    const rows = allRows<SearchRow>(
      this.db.prepare(
        `SELECT m.*, -bm25(memories_fts) AS score
         FROM memories_fts f
         JOIN memories m ON m.rowid = f.rowid
         WHERE ${where.join(" AND ")}
         ORDER BY score DESC
         LIMIT ?`,
      ),
      ...params,
      limit,
    );
    return rows.map((r) => ({ entry: rowToMemory(r), score: num(r.score) }));
  }

  archive(id: MemoryId): boolean {
    return this.db.prepare("UPDATE memories SET archived = 1 WHERE id = ?").run(id).changes > 0;
  }

  approve(id: MemoryId): boolean {
    return (
      this.db.prepare("UPDATE memories SET approved_by_user = 1 WHERE id = ?").run(id).changes > 0
    );
  }

  delete(id: MemoryId): boolean {
    return this.db.prepare("DELETE FROM memories WHERE id = ?").run(id).changes > 0;
  }
}
