import { randomUUID } from "node:crypto";
import type { OmniDatabase } from "@omniharness/session-store";
import type {
  IsoTimestamp,
  MemoryEntry,
  MemoryId,
  MemoryKind,
  MemoryQuery,
  MemorySearchResult,
  ProfileId,
  ProjectId,
  Sensitivity,
  SessionId,
} from "@omniharness/shared-types";

const DAY_MS = 86_400_000;

/** Maximum confidence an agent-proposed memory may start with. */
export const MAX_PROPOSED_CONFIDENCE = 0.7;

const SCORE_WEIGHTS = { fts: 0.5, recency: 0.3, confidence: 0.2 } as const;

export interface MemoryEngineOptions {
  /** Half-life in days for recency decay. Default 30. */
  recencyHalfLifeDays?: number;
  /** Entries not verified within this many days are archived as stale. Default 90. */
  staleAfterDays?: number;
  /** Clock override for tests. Defaults to wall time. */
  now?: () => Date;
}

export interface ProposeMemoryInput {
  kind: MemoryKind;
  profileId: ProfileId;
  projectId?: ProjectId | null;
  content: string;
  summary: string;
  sourceSessionId?: SessionId | null;
  /** Capped at {@link MAX_PROPOSED_CONFIDENCE}. Default 0.6. */
  confidence?: number;
  /** At least one reference (message/event id) backing this memory. Required. */
  evidenceRefs: string[];
  sensitivity?: Sensitivity;
  expiresAt?: IsoTimestamp | null;
}

export interface AddMemoryInput {
  kind: MemoryKind;
  profileId: ProfileId;
  projectId?: ProjectId | null;
  content: string;
  summary: string;
  sourceSessionId?: SessionId | null;
  evidenceRefs?: string[];
  sensitivity?: Sensitivity;
  expiresAt?: IsoTimestamp | null;
}

export interface CurateReport {
  /** Expired entries (expiresAt <= now) that were archived. */
  expiredArchived: MemoryId[];
  /** Entries not verified within staleAfterDays that were archived. */
  staleArchived: MemoryId[];
  /** Lower-confidence exact-content duplicates that were archived. */
  duplicatesArchived: MemoryId[];
}

export interface ProfileMemoryExport {
  version: 1;
  profileId: ProfileId;
  exportedAt: IsoTimestamp;
  entries: MemoryEntry[];
}

function newMemoryId(): MemoryId {
  return `mem_${randomUUID()}` as MemoryId;
}

/**
 * Convert free text into a safe FTS5 query: each word becomes a quoted phrase,
 * joined with OR. Returns "" when the text has no usable tokens.
 */
function toFtsQuery(text: string): string {
  const tokens = text.match(/[\p{L}\p{N}_]+/gu) ?? [];
  return tokens.map((t) => `"${t}"`).join(" OR ");
}

/**
 * Long-term memory service on top of the session-store memories repo.
 *
 * Provenance model: agents `propose()` (pending, capped confidence, evidence
 * required), users `add()` (approved, confidence 1.0) or `approve()` /
 * `reject()` proposals. Rejection archives — agent-proposed memories are never
 * hard-deleted without trace; `delete()` is the user-invoked data-rights purge.
 * Maintenance (`curate`) only ever archives, never deletes.
 */
export class MemoryEngine {
  private readonly db: OmniDatabase;
  private readonly halfLifeMs: number;
  private readonly staleMs: number;
  private readonly clock: () => Date;

  constructor(db: OmniDatabase, options: MemoryEngineOptions = {}) {
    this.db = db;
    this.halfLifeMs = (options.recencyHalfLifeDays ?? 30) * DAY_MS;
    this.staleMs = (options.staleAfterDays ?? 90) * DAY_MS;
    this.clock = options.now ?? (() => new Date());
  }

  /** Agent-proposed memory: pending approval, confidence capped, evidence required. */
  propose(input: ProposeMemoryInput): MemoryEntry {
    if (input.evidenceRefs.length === 0) {
      throw new Error("agent-proposed memories require at least one evidence reference");
    }
    const confidence = Math.min(Math.max(input.confidence ?? 0.6, 0), MAX_PROPOSED_CONFIDENCE);
    const entry = this.buildEntry(input, {
      createdBy: "agent",
      approvedByUser: false,
      confidence,
      evidenceRefs: [...input.evidenceRefs],
    });
    this.db.memories.put(entry);
    return entry;
  }

  /** User-created memory: approved, confidence 1.0. */
  add(input: AddMemoryInput): MemoryEntry {
    const entry = this.buildEntry(input, {
      createdBy: "user",
      approvedByUser: true,
      confidence: 1,
      evidenceRefs: [...(input.evidenceRefs ?? [])],
    });
    this.db.memories.put(entry);
    return entry;
  }

  /** Approve a pending proposal; also refreshes lastVerifiedAt. */
  approve(memoryId: MemoryId): boolean {
    const entry = this.db.memories.get(memoryId);
    if (entry === undefined) return false;
    this.db.memories.put({
      ...entry,
      approvedByUser: true,
      lastVerifiedAt: this.clock().toISOString(),
    });
    return true;
  }

  /** Reject a proposal: archive it. Never a hard delete — the trace stays. */
  reject(memoryId: MemoryId): boolean {
    return this.db.memories.archive(memoryId);
  }

  /** User data-rights purge: hard delete. This is the only hard-delete path. */
  delete(memoryId: MemoryId): boolean {
    return this.db.memories.delete(memoryId);
  }

  get(memoryId: MemoryId): MemoryEntry | undefined {
    return this.db.memories.get(memoryId);
  }

  /**
   * FTS5 search rescored as
   * `0.5*ftsNorm + 0.3*recency + 0.2*confidence`, where ftsNorm is the bm25
   * rank normalized within the candidate set and recency is an exponential
   * decay over lastVerifiedAt with the configured half-life.
   *
   * Scope isolation is enforced at the SQL layer by the repo: results are
   * always restricted to query.profileId, and when query.projectId is set only
   * that project's and profile-wide (null projectId) memories match.
   */
  search(query: MemoryQuery): MemorySearchResult[] {
    const limit = query.limit ?? 20;
    // Over-fetch so rescoring can promote candidates beyond the raw bm25 cut.
    const candidates = this.db.memories.search({ ...query, limit: Math.max(limit * 5, 50) });
    if (candidates.length === 0) return [];

    const nowMs = this.clock().getTime();
    const maxFts = candidates.reduce((acc, c) => Math.max(acc, c.score), 0);
    const scored: MemorySearchResult[] = candidates.map(({ entry, score }) => {
      const ftsNorm = maxFts > 0 ? score / maxFts : 0;
      const ageMs = Math.max(0, nowMs - Date.parse(entry.lastVerifiedAt));
      const recency = 0.5 ** (ageMs / this.halfLifeMs);
      return {
        entry,
        score:
          SCORE_WEIGHTS.fts * ftsNorm +
          SCORE_WEIGHTS.recency * recency +
          SCORE_WEIGHTS.confidence * entry.confidence,
      };
    });
    scored.sort(
      (a, b) =>
        b.score - a.score ||
        Date.parse(b.entry.createdAt) - Date.parse(a.entry.createdAt) ||
        (a.entry.id < b.entry.id ? -1 : 1),
    );
    return scored.slice(0, limit);
  }

  /**
   * Maintenance pass. Archives (never deletes): expired entries, entries not
   * verified within staleAfterDays, and exact-content duplicates keeping the
   * highest-confidence (then most recent) survivor.
   */
  curate(now: Date = this.clock()): CurateReport {
    const nowMs = now.getTime();
    const report: CurateReport = {
      expiredArchived: [],
      staleArchived: [],
      duplicatesArchived: [],
    };
    const rows = this.db.raw.prepare("SELECT DISTINCT profile_id FROM memories").all() as Array<{
      profile_id: string;
    }>;
    for (const row of rows) {
      const entries = this.db.memories.listByProfile(row.profile_id as ProfileId);
      const survivors: MemoryEntry[] = [];
      for (const entry of entries) {
        if (entry.expiresAt !== null && Date.parse(entry.expiresAt) <= nowMs) {
          this.db.memories.archive(entry.id);
          report.expiredArchived.push(entry.id);
        } else if (nowMs - Date.parse(entry.lastVerifiedAt) > this.staleMs) {
          this.db.memories.archive(entry.id);
          report.staleArchived.push(entry.id);
        } else {
          survivors.push(entry);
        }
      }
      const byContent = new Map<string, MemoryEntry[]>();
      for (const entry of survivors) {
        const group = byContent.get(entry.content);
        if (group === undefined) byContent.set(entry.content, [entry]);
        else group.push(entry);
      }
      for (const group of byContent.values()) {
        if (group.length < 2) continue;
        group.sort(
          (a, b) =>
            b.confidence - a.confidence || Date.parse(b.createdAt) - Date.parse(a.createdAt),
        );
        for (const duplicate of group.slice(1)) {
          this.db.memories.archive(duplicate.id);
          report.duplicatesArchived.push(duplicate.id);
        }
      }
    }
    return report;
  }

  /**
   * Markdown block of memories for injection into a system prompt. Only
   * user-approved memories surface; secret-adjacent entries are excluded.
   * Returns "" when there is nothing to inject. `projectId` null = no project
   * filter (whole profile). When `queryText` yields no FTS tokens, falls back
   * to the most recent approved memories.
   */
  buildContextBlock(
    profileId: ProfileId,
    projectId: ProjectId | null,
    queryText?: string,
    maxEntries = 8,
  ): string {
    let entries: MemoryEntry[];
    const ftsText = queryText === undefined ? "" : toFtsQuery(queryText);
    if (ftsText.length > 0) {
      const query: MemoryQuery = {
        text: ftsText,
        profileId,
        approvedOnly: true,
        limit: maxEntries,
      };
      if (projectId !== null) query.projectId = projectId;
      entries = this.search(query).map((r) => r.entry);
    } else {
      entries = this.db.memories
        .listByProfile(profileId)
        .filter(
          (e) =>
            e.approvedByUser &&
            (projectId === null || e.projectId === null || e.projectId === projectId),
        )
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .slice(0, maxEntries);
    }
    const visible = entries.filter((e) => e.sensitivity !== "secret-adjacent");
    if (visible.length === 0) return "";
    const lines = visible.map((e) => `- **${e.kind}** ${e.summary} — ${e.content}`);
    return ["## Long-term Memory", "", ...lines].join("\n");
  }

  /** Export all non-archived memories of a profile as JSON text. */
  exportProfile(profileId: ProfileId): string {
    const payload: ProfileMemoryExport = {
      version: 1,
      profileId,
      exportedAt: this.clock().toISOString(),
      entries: this.db.memories.listByProfile(profileId),
    };
    return JSON.stringify(payload, null, 2);
  }

  /**
   * Import previously exported entries, marking provenance as `createdBy:
   * "import"`. Existing ids are preserved; a clashing id gets a fresh one.
   */
  importEntries(entries: MemoryEntry[], options: { source: "import" }): MemoryEntry[] {
    const imported: MemoryEntry[] = [];
    for (const entry of entries) {
      const id = this.db.memories.get(entry.id) === undefined ? entry.id : newMemoryId();
      const record: MemoryEntry = { ...entry, id, createdBy: options.source, archived: false };
      this.db.memories.put(record);
      imported.push(record);
    }
    return imported;
  }

  private buildEntry(
    input: ProposeMemoryInput | AddMemoryInput,
    provenance: {
      createdBy: MemoryEntry["createdBy"];
      approvedByUser: boolean;
      confidence: number;
      evidenceRefs: string[];
    },
  ): MemoryEntry {
    const now = this.clock().toISOString();
    const projectId = input.projectId ?? null;
    return {
      id: newMemoryId(),
      kind: input.kind,
      profileId: input.profileId,
      projectId,
      content: input.content,
      summary: input.summary,
      sourceSessionId: input.sourceSessionId ?? null,
      createdBy: provenance.createdBy,
      createdAt: now,
      lastVerifiedAt: now,
      confidence: provenance.confidence,
      scope: { profileId: input.profileId, projectId },
      approvedByUser: provenance.approvedByUser,
      evidenceRefs: provenance.evidenceRefs,
      sensitivity: input.sensitivity ?? "normal",
      expiresAt: input.expiresAt ?? null,
      archived: false,
    };
  }
}
