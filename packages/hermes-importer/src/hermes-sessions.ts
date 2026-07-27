import { DatabaseSync } from "node:sqlite";
import type {
  IsoTimestamp,
  Message,
  MessageId,
  MessagePart,
  ProfileId,
  ProjectId,
  Session,
  SessionId,
  SessionStatus,
  WorkspaceId,
} from "@omniharness/shared-types";
import { nowIso } from "@omniharness/shared-types";
import type { OmniDatabase } from "@omniharness/session-store";
import { ImportStateTracker } from "./import-state.js";
import { asArray, asNumber, asRecord, asString, errMessage } from "./json-utils.js";
import { type ImportOptions, type ImportReport, ImportReportBuilder } from "./report.js";

/**
 * Importer for Hermes `state.db` (see docs/research/HERMES_AUDIT.md §3.8).
 *
 * The source is a SQLite database with `sessions` and `messages` tables plus
 * FTS5 sidecar indexes (`messages_fts`, ...). It is opened READ-ONLY via
 * node:sqlite. Ordering is always insertion order (`ORDER BY messages.id`),
 * never timestamp — Hermes does this deliberately (clock skew).
 *
 * Flag semantics (upstream): active=1 → live; active=0,compacted=0 → rewound
 * (skipped here); active=0,compacted=1 → compaction-archived (still imported,
 * the compaction point gets a system marker message). Summary rows carrying
 * the `[CONTEXT COMPACTION — REFERENCE ONLY]` prefix also become system
 * marker messages.
 *
 * Session status mapping: archived=1 or ended → "archived", else "active".
 */

/** Prefix Hermes writes on context-compaction summary message rows. */
export const HERMES_COMPACTION_PREFIX = "[CONTEXT COMPACTION";

export interface HermesSessionsImportOptions extends ImportOptions {
  /** Path to the Hermes state.db file. */
  stateDbPath: string;
  db: OmniDatabase;
  workspaceId: WorkspaceId;
  /** Defaults to the workspace's project. */
  projectId?: ProjectId;
  /** Defaults to the default profile. */
  profileId?: ProfileId;
}

interface HermesSessionRow {
  id: string;
  title: string | null;
  display_name: string | null;
  source: string | null;
  model: string | null;
  started_at: number | null;
  ended_at: number | null;
  end_reason: string | null;
  archived: number | null;
}

interface HermesMessageRow {
  id: number;
  role: string | null;
  content: string | null;
  tool_call_id: string | null;
  tool_calls: string | null;
  tool_name: string | null;
  timestamp: number | null;
  reasoning: string | null;
  active: number | null;
  compacted: number | null;
}

function epochToIso(seconds: number | null): IsoTimestamp {
  if (seconds === null || !Number.isFinite(seconds)) return nowIso();
  return new Date(seconds * 1000).toISOString();
}

/** Parse a Hermes `content` cell (plain text or multimodal-parts JSON) into parts. */
function hermesContentToParts(content: string | null, report: ImportReportBuilder, ctx: string): MessagePart[] {
  if (content === null || content.length === 0) return [];
  const trimmed = content.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const blocks = asArray(parsed);
      if (blocks !== undefined) {
        const parts: MessagePart[] = [];
        for (const block of blocks) {
          const rec = asRecord(block);
          if (rec === undefined) continue;
          const type = asString(rec["type"]);
          if (type === "text") {
            const text = asString(rec["text"]);
            if (text !== undefined) parts.push({ type: "text", text });
          } else if (type === "image") {
            const mimeType = asString(rec["mimeType"]) ?? "image/*";
            const data = asString(rec["data"]);
            if (data !== undefined) {
              parts.push({
                type: "attachment",
                attachment: {
                  kind: "image",
                  uri: `data:${mimeType};base64,${data}`,
                  mimeType,
                  sizeBytes: Math.floor(data.length * 0.75),
                  name: "hermes-imported-image",
                },
              });
            } else {
              parts.push({ type: "text", text: `[image ${mimeType}]` });
            }
          } else if (type === "tool_use" || type === "toolCall") {
            const part: MessagePart = {
              type: "tool_call",
              toolName: asString(rec["name"]) ?? "unknown",
              argumentsJson: JSON.stringify(rec["input"] ?? rec["arguments"] ?? {}),
            };
            const callId = asString(rec["id"]);
            if (callId !== undefined) part.toolCallId = callId as MessagePart["toolCallId"];
            parts.push(part);
          } else {
            parts.push({ type: "text", text: JSON.stringify(rec) });
          }
        }
        return parts;
      }
      // A JSON object/string scalar: keep it as text.
      return [{ type: "text", text: content }];
    } catch {
      report.warn(`${ctx}: content looked like JSON but failed to parse; kept as plain text`);
      return [{ type: "text", text: content }];
    }
  }
  return [{ type: "text", text: content }];
}

function hermesToolCallsToParts(toolCallsJson: string | null): MessagePart[] {
  if (toolCallsJson === null) return [];
  try {
    const parsed: unknown = JSON.parse(toolCallsJson);
    const calls = asArray(parsed);
    if (calls === undefined) return [];
    const parts: MessagePart[] = [];
    for (const call of calls) {
      const rec = asRecord(call);
      if (rec === undefined) continue;
      const fn = asRecord(rec["function"]);
      const part: MessagePart = {
        type: "tool_call",
        toolName: asString(rec["name"]) ?? (fn === undefined ? undefined : asString(fn["name"])) ?? "unknown",
        argumentsJson:
          typeof rec["arguments"] === "string"
            ? rec["arguments"]
            : JSON.stringify(rec["arguments"] ?? (fn === undefined ? {} : fn["arguments"] ?? {})),
      };
      const callId = asString(rec["id"]);
      if (callId !== undefined) part.toolCallId = callId as MessagePart["toolCallId"];
      parts.push(part);
    }
    return parts;
  } catch {
    return [];
  }
}

function mapRole(role: string | null, report: ImportReportBuilder, ctx: string): Message["role"] {
  switch (role) {
    case "user":
      return "user";
    case "assistant":
      return "assistant";
    case "system":
      return "system";
    case "tool":
    case "toolResult":
    case "tool_result":
      return "tool";
    default:
      report.warn(`${ctx}: unknown role "${role ?? "?"}" mapped to system`);
      return "system";
  }
}

function sessionStatus(row: HermesSessionRow): SessionStatus {
  return row.archived === 1 || row.ended_at !== null ? "archived" : "active";
}

function tableExists(db: DatabaseSync, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE (type='table' OR type='virtual table') AND name = ?")
    .get(name);
  return row !== undefined;
}

/** Import all sessions (+ messages) from a Hermes state.db. */
export function importHermesSessions(options: HermesSessionsImportOptions): ImportReport {
  const report = new ImportReportBuilder();
  const dryRun = options.dryRun ?? false;
  const tracker = new ImportStateTracker(options.db, "hermes.sessions", dryRun);

  let source: DatabaseSync;
  try {
    source = new DatabaseSync(options.stateDbPath, { readOnly: true });
  } catch (err) {
    report.error(options.stateDbPath, `cannot open state.db read-only: ${errMessage(err)}`);
    return report.finish();
  }

  try {
    if (!tableExists(source, "sessions") || !tableExists(source, "messages")) {
      report.error(options.stateDbPath, "state.db does not contain sessions/messages tables");
      return report.finish();
    }
    // FTS sidecars are informational: our store keeps its own FTS index, but
    // note when the source lacks one (history search there was degraded).
    if (!tableExists(source, "messages_fts")) {
      report.warn("state.db has no messages_fts table; nothing to note, FTS is rebuilt on our side");
    }

    const workspace = options.db.workspaces.get(options.workspaceId);
    if (workspace === undefined) {
      report.error(options.stateDbPath, `workspace ${options.workspaceId} not found in database`);
      return report.finish();
    }
    const projectId = options.projectId ?? workspace.projectId;
    const profileId =
      options.profileId ?? (options.db.profiles.getDefault()?.id as ProfileId | undefined);
    if (profileId === undefined) {
      report.error(options.stateDbPath, "could not resolve profileId (pass it explicitly)");
      return report.finish();
    }

    const sessionRows = source
      .prepare(
        `SELECT id, title, display_name, source, model, started_at, ended_at, end_reason, archived
         FROM sessions ORDER BY started_at, id`,
      )
      .all() as unknown as HermesSessionRow[];

    const messageStmt = source.prepare(
      `SELECT id, role, content, tool_call_id, tool_calls, tool_name, timestamp, reasoning, active, compacted
       FROM messages WHERE session_id = ? ORDER BY id`,
    );

    for (const row of sessionRows) {
      const sourceKey = row.id;
      if (tracker.has(sourceKey)) {
        report.skip(sourceKey, `already imported as ${tracker.targetOf(sourceKey) ?? "?"}`);
        continue;
      }
      const sessionId = `sess_hermes_${row.id}` as SessionId;
      const messageRows = messageStmt.all(row.id) as unknown as HermesMessageRow[];

      const messages: Message[] = [];
      let compactedCount = 0;
      let lastCompactedIndex = -1;
      let previousId: MessageId | null = null;
      for (const m of messageRows) {
        const active = m.active ?? 1;
        const compacted = m.compacted ?? 0;
        if (active === 0 && compacted === 0) {
          report.skip(`${row.id}/${m.id}`, "rewound message (active=0, compacted=0)");
          continue;
        }
        const messageId = `msg_hermes_${row.id}_${m.id}` as MessageId;
        const ctx = `session ${row.id} message ${m.id}`;
        const isCompactionSummary =
          typeof m.content === "string" && m.content.startsWith(HERMES_COMPACTION_PREFIX);

        let role = mapRole(m.role, report, ctx);
        let parts: MessagePart[];
        if (isCompactionSummary) {
          role = "system";
          parts = [{ type: "text", text: `[compaction marker] ${m.content ?? ""}` }];
        } else if (role === "tool") {
          const part: MessagePart = {
            type: "tool_result",
            toolName: m.tool_name ?? "unknown",
            resultJson: JSON.stringify(m.content ?? null),
          };
          if (m.tool_call_id !== null) {
            part.toolCallId = m.tool_call_id as MessagePart["toolCallId"];
          }
          parts = [part];
        } else {
          parts = hermesContentToParts(m.content, report, ctx);
          if (m.reasoning !== null && m.reasoning.length > 0) {
            parts.unshift({ type: "reasoning", text: m.reasoning });
          }
          parts.push(...hermesToolCallsToParts(m.tool_calls));
        }
        if (compacted === 1) compactedCount += 1;

        const message: Message = {
          id: messageId,
          sessionId,
          parentId: previousId,
          role,
          parts,
          createdAt: epochToIso(m.timestamp),
        };
        messages.push(message);
        previousId = messageId;
      }

      // One synthetic marker at the compaction boundary: sessions with
      // compacted rows had their earlier history folded into a summary.
      if (compactedCount > 0) {
        const markerIndex = messages.findIndex((m) => {
          const rowId = Number(m.id.slice(`msg_hermes_${row.id}_`.length));
          const source_row = messageRows.find((r) => r.id === rowId);
          return (source_row?.compacted ?? 0) === 0;
        });
        const marker: Message = {
          id: `msg_hermes_${row.id}_compaction-marker` as MessageId,
          sessionId,
          parentId: markerIndex > 0 ? (messages[markerIndex - 1]?.id ?? null) : (messages[markerIndex - 1] === undefined && messages.length > 0 && markerIndex === -1 ? messages[messages.length - 1]!.id : null),
          role: "system",
          parts: [
            {
              type: "text",
              text: `[compaction marker] ${compactedCount} earlier message(s) were compacted in the source Hermes session`,
            },
          ],
          createdAt: messages[Math.max(0, markerIndex === -1 ? messages.length - 1 : markerIndex)]?.createdAt ?? nowIso(),
        };
        const insertAt = markerIndex === -1 ? messages.length : markerIndex;
        if (insertAt > 0) marker.parentId = messages[insertAt - 1]!.id;
        messages.splice(insertAt, 0, marker);
        // Re-thread the linear parent chain after the splice.
        for (let i = insertAt + 1; i < messages.length; i++) {
          messages[i]!.parentId = messages[i - 1]!.id;
        }
      }

      const createdAt = epochToIso(row.started_at);
      const session: Session = {
        id: sessionId,
        profileId,
        projectId,
        workspaceId: options.workspaceId,
        title: row.title ?? row.display_name ?? `Hermes session ${row.id}`,
        tags: ["imported", "hermes"],
        status: sessionStatus(row),
        headMessageId: messages.length > 0 ? messages[messages.length - 1]!.id : null,
        createdAt,
        updatedAt: epochToIso(row.ended_at ?? row.started_at),
        totalUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
      if (row.end_reason !== null) session.tags.push(`end:${row.end_reason}`);

      if (!dryRun) {
        options.db.transaction(() => {
          options.db.sessions.create(session);
          for (const message of messages) options.db.messages.add(message);
        });
        tracker.mark(sourceKey, sessionId);
      }
      report.imported(1 + messages.length);
    }
  } finally {
    source.close();
  }
  return report.finish();
}
