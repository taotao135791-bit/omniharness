import { readFileSync } from "node:fs";
import type {
  IsoTimestamp,
  Message,
  MessageId,
  MessagePart,
  ModelId,
  ProfileId,
  ProjectId,
  Session,
  SessionId,
  TokenUsage,
  ToolCallId,
  WorkspaceId,
} from "@omniharness/shared-types";
import { nowIso } from "@omniharness/shared-types";
import type { OmniDatabase } from "@omniharness/session-store";
import { ImportStateTracker } from "./import-state.js";
import { asArray, asNumber, asRecord, asString, errMessage } from "./json-utils.js";
import { type ImportOptions, type ImportReport, ImportReportBuilder } from "./report.js";

/**
 * Importer for Pi session files: JSONL, format v3 (see docs/research/PI_AUDIT.md §3.6
 * and upstream packages/coding-agent/src/core/session-manager.ts).
 *
 * Line 1 is a session header `{type:"session", version, id, timestamp, cwd}`.
 * Every following line is a `SessionEntry` with `id` + `parentId` forming a
 * tree (branches). Entry kinds: message, thinking_level_change, model_change,
 * compaction, branch_summary, custom, custom_message, label, session_info.
 *
 * Mapping into OmniHarness:
 * - one `Session` per file (`sess_pi_<piSessionId>`), all branches preserved;
 * - every entry becomes a `Message` node with the same parent links, so the
 *   tree structure survives intact — conversation-bearing entries map to
 *   user/assistant/tool roles, bookkeeping entries (model_change, label, ...)
 *   become `system` marker messages, and unknown kinds are preserved as raw
 *   JSON in a `system` message (never dropped silently) plus a warning.
 */

export interface PiSessionImportOptions extends ImportOptions {
  workspaceId: WorkspaceId;
  /** Defaults to the workspace's project. */
  projectId?: ProjectId;
  /** Defaults to the default profile in the database. */
  profileId?: ProfileId;
}

interface PiHeader {
  id: string;
  timestamp: string | undefined;
  cwd: string | undefined;
  version: number | undefined;
}

interface PiEntry {
  line: number;
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string | undefined;
  raw: Record<string, unknown>;
}

const KNOWN_NON_MESSAGE_KINDS = new Set([
  "thinking_level_change",
  "model_change",
  "custom",
  "label",
  "session_info",
]);

/** Convert one Pi content block (or raw string content) into our message parts. */
function contentToParts(content: unknown, report: ImportReportBuilder, entryId: string): MessagePart[] {
  if (typeof content === "string") {
    return content.length > 0 ? [{ type: "text", text: content }] : [];
  }
  const blocks = asArray(content);
  if (blocks === undefined) {
    if (content === undefined || content === null) return [];
    report.warn(`entry ${entryId}: unrecognized content shape, preserved as JSON text`);
    return [{ type: "text", text: JSON.stringify(content) }];
  }
  const parts: MessagePart[] = [];
  for (const block of blocks) {
    const rec = asRecord(block);
    if (rec === undefined) {
      report.warn(`entry ${entryId}: unrecognized content block, preserved as JSON text`);
      parts.push({ type: "text", text: JSON.stringify(block) });
      continue;
    }
    const blockType = asString(rec["type"]);
    switch (blockType) {
      case "text": {
        parts.push({ type: "text", text: asString(rec["text"]) ?? "" });
        break;
      }
      case "thinking": {
        parts.push({ type: "reasoning", text: asString(rec["thinking"]) ?? "" });
        break;
      }
      case "image": {
        const data = asString(rec["data"]);
        const mimeType = asString(rec["mimeType"]) ?? "image/png";
        if (data === undefined) {
          parts.push({ type: "text", text: "[image content without data]" });
        } else {
          parts.push({
            type: "attachment",
            attachment: {
              kind: "image",
              uri: `data:${mimeType};base64,${data}`,
              mimeType,
              sizeBytes: Math.floor(data.length * 0.75),
              name: "pi-imported-image",
            },
          });
        }
        break;
      }
      case "toolCall": {
        const part: MessagePart = {
          type: "tool_call",
          toolName: asString(rec["name"]) ?? "unknown",
          argumentsJson: JSON.stringify(rec["arguments"] ?? {}),
        };
        const callId = asString(rec["id"]);
        if (callId !== undefined) part.toolCallId = callId as ToolCallId;
        parts.push(part);
        break;
      }
      default: {
        report.warn(
          `entry ${entryId}: unknown content block type "${blockType ?? "?"}" preserved as JSON text`,
        );
        parts.push({ type: "text", text: JSON.stringify(rec) });
      }
    }
  }
  return parts;
}

function piUsageToTokenUsage(usage: unknown): TokenUsage | undefined {
  const rec = asRecord(usage);
  if (rec === undefined) return undefined;
  const result: TokenUsage = {
    inputTokens: asNumber(rec["input"]) ?? 0,
    outputTokens: asNumber(rec["output"]) ?? 0,
    cacheReadTokens: asNumber(rec["cacheRead"]) ?? 0,
    cacheWriteTokens: asNumber(rec["cacheWrite"]) ?? 0,
  };
  const cost = asRecord(rec["cost"]);
  const total = cost === undefined ? undefined : asNumber(cost["total"]);
  if (total !== undefined) result.costUsd = total;
  return result;
}

/** Serialize tool-result content blocks to JSON for the tool_result part. */
function toolResultJson(content: unknown): string {
  const blocks = asArray(content);
  if (blocks === undefined) return JSON.stringify(content ?? null);
  const simplified = blocks.map((block) => {
    const rec = asRecord(block);
    if (rec === undefined) return block;
    if (asString(rec["type"]) === "image") {
      return { type: "image", mimeType: asString(rec["mimeType"]) ?? "image/*", data: "[base64 omitted]" };
    }
    return rec;
  });
  return JSON.stringify(simplified);
}

interface ConvertedEntry {
  message: Message;
  /** True for entries that carry conversation content (affects nothing structurally). */
  kind: "conversation" | "marker" | "raw";
}

function convertEntry(
  entry: PiEntry,
  sessionId: SessionId,
  header: PiHeader,
  idMap: ReadonlyMap<string, MessageId>,
  report: ImportReportBuilder,
): ConvertedEntry {
  const messageId = `msg_pi_${header.id}_${entry.id}` as MessageId;
  let parentId: MessageId | null = null;
  if (entry.parentId !== null) {
    const mapped = idMap.get(entry.parentId);
    if (mapped === undefined) {
      report.warn(
        `entry ${entry.id}: parentId ${entry.parentId} not found; attached at tree root`,
      );
    } else {
      parentId = mapped;
    }
  }
  const createdAt: IsoTimestamp = entry.timestamp ?? header.timestamp ?? nowIso();

  let role: Message["role"] = "system";
  let parts: MessagePart[] = [];
  let kind: ConvertedEntry["kind"] = "marker";
  let modelId: ModelId | undefined;
  let usage: TokenUsage | undefined;

  switch (entry.type) {
    case "message": {
      const msg = asRecord(entry.raw["message"]);
      if (msg === undefined) {
        report.warn(`entry ${entry.id}: message entry without a "message" object; kept raw`);
        parts = [{ type: "text", text: JSON.stringify(entry.raw) }];
        kind = "raw";
        break;
      }
      const msgRole = asString(msg["role"]);
      kind = "conversation";
      if (msgRole === "user") {
        role = "user";
        parts = contentToParts(msg["content"], report, entry.id);
      } else if (msgRole === "assistant") {
        role = "assistant";
        parts = contentToParts(msg["content"], report, entry.id);
        const provider = asString(msg["provider"]);
        const model = asString(msg["model"]);
        if (provider !== undefined && model !== undefined) {
          modelId = `${provider}/${model}` as ModelId;
        }
        usage = piUsageToTokenUsage(msg["usage"]);
        const errorMessage = asString(msg["errorMessage"]);
        if (errorMessage !== undefined) {
          parts.push({ type: "error", text: errorMessage, isError: true });
        }
      } else if (msgRole === "toolResult") {
        role = "tool";
        const part: MessagePart = {
          type: "tool_result",
          toolName: asString(msg["toolName"]) ?? "unknown",
          resultJson: toolResultJson(msg["content"]),
        };
        const callId = asString(msg["toolCallId"]);
        if (callId !== undefined) part.toolCallId = callId as ToolCallId;
        if (msg["isError"] === true) part.isError = true;
        parts = [part];
        usage = piUsageToTokenUsage(msg["usage"]);
      } else {
        role = "system";
        kind = "raw";
        report.warn(
          `entry ${entry.id}: unknown message role "${msgRole ?? "?"}" preserved as raw`,
        );
        parts = [{ type: "text", text: JSON.stringify(entry.raw) }];
      }
      break;
    }
    case "custom_message": {
      // Injected into LLM context as a user message upstream (see PI_AUDIT §3.6).
      role = "user";
      kind = "conversation";
      parts = contentToParts(entry.raw["content"], report, entry.id);
      const customType = asString(entry.raw["customType"]);
      if (customType !== undefined) {
        parts.unshift({ type: "text", text: `[pi:custom_message:${customType}]` });
      }
      break;
    }
    case "compaction": {
      role = "system";
      kind = "marker";
      const summary = asString(entry.raw["summary"]) ?? "";
      const tokensBefore = asNumber(entry.raw["tokensBefore"]);
      parts = [
        {
          type: "text",
          text: `[pi:compaction${tokensBefore !== undefined ? ` tokensBefore=${tokensBefore}` : ""}] ${summary}`,
        },
      ];
      usage = piUsageToTokenUsage(entry.raw["usage"]);
      break;
    }
    case "branch_summary": {
      role = "system";
      kind = "marker";
      const fromId = asString(entry.raw["fromId"]) ?? "?";
      const summary = asString(entry.raw["summary"]) ?? "";
      parts = [{ type: "text", text: `[pi:branch_summary from=${fromId}] ${summary}` }];
      usage = piUsageToTokenUsage(entry.raw["usage"]);
      break;
    }
    default: {
      role = "system";
      if (KNOWN_NON_MESSAGE_KINDS.has(entry.type)) {
        kind = "marker";
        const { type: _type, id: _id, parentId: _parentId, timestamp: _ts, ...rest } = entry.raw;
        parts = [{ type: "text", text: `[pi:${entry.type}] ${JSON.stringify(rest)}` }];
      } else {
        kind = "raw";
        report.warn(`entry ${entry.id}: unknown entry kind "${entry.type}" preserved as raw`);
        parts = [{ type: "text", text: JSON.stringify(entry.raw) }];
      }
    }
  }

  const message: Message = {
    id: messageId,
    sessionId,
    parentId,
    role,
    parts,
    createdAt,
  };
  if (modelId !== undefined) message.modelId = modelId;
  if (usage !== undefined) message.usage = usage;
  return { message, kind };
}

function parseHeader(line: string): PiHeader | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  const rec = asRecord(value);
  if (rec === undefined || rec["type"] !== "session") return undefined;
  const id = asString(rec["id"]);
  if (id === undefined) return undefined;
  return {
    id,
    timestamp: asString(rec["timestamp"]),
    cwd: asString(rec["cwd"]),
    version: asNumber(rec["version"]),
  };
}

/**
 * Import one Pi JSONL session file into the session store. Returns a report;
 * malformed lines are reported as errors and skipped, the import continues.
 * Re-importing the same file is a no-op (the session is reported as skipped).
 */
export function importPiSession(
  path: string,
  db: OmniDatabase,
  options: PiSessionImportOptions,
): ImportReport {
  const report = new ImportReportBuilder();
  const dryRun = options.dryRun ?? false;
  const tracker = new ImportStateTracker(db, "pi.session", dryRun);

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    report.error(path, `cannot read session file: ${errMessage(err)}`);
    return report.finish();
  }

  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  const firstLine = lines[0];
  const header = firstLine === undefined ? undefined : parseHeader(firstLine);
  if (header === undefined) {
    report.error(path, "first line is not a valid Pi session header ({type:\"session\", id, ...})");
    return report.finish();
  }
  if (header.version !== undefined && header.version !== 3) {
    report.warn(`session version is ${header.version}, expected 3; importing best-effort`);
  }

  const sourceKey = header.id;
  if (tracker.has(sourceKey)) {
    report.skip(sourceKey, `already imported as ${tracker.targetOf(sourceKey) ?? "?"}`);
    return report.finish();
  }

  // Parse all entry lines first so a malformed line never aborts the import.
  const entries: PiEntry[] = [];
  for (let i = 1; i < lines.length; i++) {
    const lineText = lines[i]!;
    const lineNo = i + 1;
    let value: unknown;
    try {
      value = JSON.parse(lineText);
    } catch (err) {
      report.error(`line ${lineNo}`, `malformed JSONL line skipped: ${errMessage(err)}`);
      continue;
    }
    const rec = asRecord(value);
    const type = rec === undefined ? undefined : asString(rec["type"]);
    const id = rec === undefined ? undefined : asString(rec["id"]);
    if (rec === undefined || type === undefined || id === undefined) {
      report.error(`line ${lineNo}`, "entry missing type/id; skipped");
      continue;
    }
    const rawParent = rec["parentId"];
    entries.push({
      line: lineNo,
      type,
      id,
      parentId: typeof rawParent === "string" ? rawParent : null,
      timestamp: asString(rec["timestamp"]),
      raw: rec,
    });
  }

  // Resolve the FK chain for the new session.
  const workspace = db.workspaces.get(options.workspaceId);
  const projectId = options.projectId ?? workspace?.projectId;
  const profileId = options.profileId ?? (db.profiles.getDefault()?.id as ProfileId | undefined);
  if (workspace === undefined) {
    report.error(path, `workspace ${options.workspaceId} not found in database`);
    return report.finish();
  }
  if (projectId === undefined || profileId === undefined) {
    report.error(path, "could not resolve projectId/profileId (pass them explicitly)");
    return report.finish();
  }

  const sessionId = `sess_pi_${header.id}` as SessionId;
  const idMap = new Map<string, MessageId>();
  for (const entry of entries) {
    idMap.set(entry.id, `msg_pi_${header.id}_${entry.id}` as MessageId);
  }

  const converted: ConvertedEntry[] = [];
  let sessionName: string | undefined;
  for (const entry of entries) {
    if (entry.type === "session_info") {
      sessionName = asString(entry.raw["name"]) ?? sessionName;
    }
    converted.push(convertEntry(entry, sessionId, header, idMap, report));
  }
  const lastEntry = converted[converted.length - 1];
  const headMessageId = lastEntry === undefined ? null : lastEntry.message.id;

  const timestamp = header.timestamp ?? nowIso();
  const session: Session = {
    id: sessionId,
    profileId,
    projectId,
    workspaceId: options.workspaceId,
    title: sessionName ?? `Pi session ${header.id} (${header.cwd ?? "unknown cwd"})`,
    tags: ["imported", "pi"],
    status: "active",
    headMessageId,
    createdAt: timestamp,
    updatedAt: timestamp,
    totalUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  };

  if (!dryRun) {
    db.transaction(() => {
      db.sessions.create(session);
      for (const { message } of converted) {
        db.messages.add(message);
      }
    });
    tracker.mark(sourceKey, sessionId);
  }
  report.imported(converted.length);
  return report.finish();
}

/** Stateful facade around {@link importPiSession}. */
export class PiSessionImporter {
  constructor(private readonly db: OmniDatabase) {}

  import(path: string, options: PiSessionImportOptions): ImportReport {
    return importPiSession(path, this.db, options);
  }
}
