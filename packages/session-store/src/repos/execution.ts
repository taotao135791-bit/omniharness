import type { DatabaseSync } from "node:sqlite";
import type {
  ApprovalId,
  ApprovalRequest,
  ApprovalStatus,
  Artifact,
  ArtifactId,
  Capability,
  Checkpoint,
  CheckpointId,
  IsoTimestamp,
  SessionId,
  ToolCallId,
} from "@omniharness/shared-types";
import { allRows, getRow, jparse, jstr, num } from "../helpers.js";
import type { ToolCallRecord, ToolCallStatus } from "../types.js";

interface ToolCallRow {
  id: string;
  session_id: string;
  agent_run_id: string | null;
  message_id: string | null;
  name: string;
  arguments_json: string;
  status: string;
  result_json: string | null;
  error: string | null;
  capability: string | null;
  started_at: string;
  ended_at: string | null;
}

function rowToToolCall(r: ToolCallRow): ToolCallRecord {
  return {
    id: r.id as ToolCallId,
    sessionId: r.session_id as SessionId,
    agentRunId: r.agent_run_id as ToolCallRecord["agentRunId"],
    messageId: r.message_id as ToolCallRecord["messageId"],
    name: r.name,
    argumentsJson: r.arguments_json,
    status: r.status as ToolCallStatus,
    resultJson: r.result_json,
    error: r.error,
    capability: r.capability as Capability | null,
    startedAt: r.started_at,
    endedAt: r.ended_at,
  };
}

export class ToolCallsRepo {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  put(call: ToolCallRecord): void {
    this.db
      .prepare(
        `INSERT INTO tool_calls
           (id, session_id, agent_run_id, message_id, name, arguments_json, status, result_json, error, capability, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           agent_run_id = excluded.agent_run_id, message_id = excluded.message_id,
           status = excluded.status, result_json = excluded.result_json, error = excluded.error,
           capability = excluded.capability, ended_at = excluded.ended_at`,
      )
      .run(
        call.id,
        call.sessionId,
        call.agentRunId,
        call.messageId,
        call.name,
        call.argumentsJson,
        call.status,
        call.resultJson,
        call.error,
        call.capability,
        call.startedAt,
        call.endedAt,
      );
  }

  get(id: ToolCallId): ToolCallRecord | undefined {
    const row = getRow<ToolCallRow>(this.db.prepare("SELECT * FROM tool_calls WHERE id = ?"), id);
    return row === undefined ? undefined : rowToToolCall(row);
  }

  listBySession(sessionId: SessionId): ToolCallRecord[] {
    return allRows<ToolCallRow>(
      this.db.prepare("SELECT * FROM tool_calls WHERE session_id = ? ORDER BY started_at, id"),
      sessionId,
    ).map(rowToToolCall);
  }

  finish(
    id: ToolCallId,
    status: ToolCallStatus,
    endedAt: IsoTimestamp,
    resultJson?: string,
    error?: string,
  ): boolean {
    return (
      this.db
        .prepare(
          "UPDATE tool_calls SET status = ?, ended_at = ?, result_json = ?, error = ? WHERE id = ?",
        )
        .run(status, endedAt, resultJson ?? null, error ?? null, id).changes > 0
    );
  }

  delete(id: ToolCallId): boolean {
    return this.db.prepare("DELETE FROM tool_calls WHERE id = ?").run(id).changes > 0;
  }
}

interface ApprovalRow {
  id: string;
  tool_call_id: string;
  capability: string;
  risk: string;
  summary: string;
  detail: string;
  status: string;
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  granted_scope: string | null;
  expires_at: string;
}

function rowToApproval(r: ApprovalRow): ApprovalRequest {
  const approval: ApprovalRequest = {
    id: r.id as ApprovalId,
    toolCallId: r.tool_call_id as ToolCallId,
    capability: r.capability as Capability,
    risk: r.risk as ApprovalRequest["risk"],
    summary: r.summary,
    detail: jparse<Record<string, string>>(r.detail, {}),
    status: r.status as ApprovalStatus,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
    resolvedBy: r.resolved_by as ApprovalRequest["resolvedBy"],
    expiresAt: r.expires_at,
  };
  if (r.granted_scope !== null) {
    approval.grantedScope = r.granted_scope as NonNullable<ApprovalRequest["grantedScope"]>;
  }
  return approval;
}

export class ApprovalsRepo {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  put(approval: ApprovalRequest): void {
    this.db
      .prepare(
        `INSERT INTO approvals
           (id, tool_call_id, capability, risk, summary, detail, status, created_at, resolved_at, resolved_by, granted_scope, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status, resolved_at = excluded.resolved_at,
           resolved_by = excluded.resolved_by, granted_scope = excluded.granted_scope`,
      )
      .run(
        approval.id,
        approval.toolCallId,
        approval.capability,
        approval.risk,
        approval.summary,
        jstr(approval.detail),
        approval.status,
        approval.createdAt,
        approval.resolvedAt,
        approval.resolvedBy,
        approval.grantedScope ?? null,
        approval.expiresAt,
      );
  }

  get(id: ApprovalId): ApprovalRequest | undefined {
    const row = getRow<ApprovalRow>(this.db.prepare("SELECT * FROM approvals WHERE id = ?"), id);
    return row === undefined ? undefined : rowToApproval(row);
  }

  listByStatus(status: ApprovalStatus): ApprovalRequest[] {
    return allRows<ApprovalRow>(
      this.db.prepare("SELECT * FROM approvals WHERE status = ? ORDER BY created_at, id"),
      status,
    ).map(rowToApproval);
  }

  listByToolCall(toolCallId: ToolCallId): ApprovalRequest[] {
    return allRows<ApprovalRow>(
      this.db.prepare("SELECT * FROM approvals WHERE tool_call_id = ? ORDER BY created_at, id"),
      toolCallId,
    ).map(rowToApproval);
  }

  resolve(
    id: ApprovalId,
    status: ApprovalStatus,
    resolvedBy: NonNullable<ApprovalRequest["resolvedBy"]>,
    resolvedAt: IsoTimestamp,
    grantedScope?: ApprovalRequest["grantedScope"],
  ): boolean {
    return (
      this.db
        .prepare(
          "UPDATE approvals SET status = ?, resolved_by = ?, resolved_at = ?, granted_scope = ? WHERE id = ?",
        )
        .run(status, resolvedBy, resolvedAt, grantedScope ?? null, id).changes > 0
    );
  }

  delete(id: ApprovalId): boolean {
    return this.db.prepare("DELETE FROM approvals WHERE id = ?").run(id).changes > 0;
  }
}

interface CheckpointRow {
  id: string;
  session_id: string;
  kind: string;
  ref: string;
  label: string;
  created_at: string;
}

export class CheckpointsRepo {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  put(checkpoint: Checkpoint): void {
    this.db
      .prepare(
        `INSERT INTO checkpoints (id, session_id, kind, ref, label, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           kind = excluded.kind, ref = excluded.ref, label = excluded.label`,
      )
      .run(
        checkpoint.id,
        checkpoint.sessionId,
        checkpoint.kind,
        checkpoint.ref,
        checkpoint.label,
        checkpoint.createdAt,
      );
  }

  get(id: CheckpointId): Checkpoint | undefined {
    const row = getRow<CheckpointRow>(
      this.db.prepare("SELECT * FROM checkpoints WHERE id = ?"),
      id,
    );
    if (row === undefined) return undefined;
    return {
      id: row.id,
      sessionId: row.session_id,
      kind: row.kind as Checkpoint["kind"],
      ref: row.ref,
      label: row.label,
      createdAt: row.created_at,
    };
  }

  listBySession(sessionId: SessionId): Checkpoint[] {
    return allRows<CheckpointRow>(
      this.db.prepare("SELECT * FROM checkpoints WHERE session_id = ? ORDER BY created_at, id"),
      sessionId,
    ).map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      kind: r.kind as Checkpoint["kind"],
      ref: r.ref,
      label: r.label,
      createdAt: r.created_at,
    }));
  }

  delete(id: CheckpointId): boolean {
    return this.db.prepare("DELETE FROM checkpoints WHERE id = ?").run(id).changes > 0;
  }
}

interface ArtifactRow {
  id: string;
  kind: string;
  name: string;
  mime_type: string;
  size_bytes: number;
  uri: string;
  created_at: string;
}

function rowToArtifact(r: ArtifactRow): Artifact {
  return {
    id: r.id,
    kind: r.kind as Artifact["kind"],
    name: r.name,
    mimeType: r.mime_type,
    sizeBytes: num(r.size_bytes),
    uri: r.uri,
    createdAt: r.created_at,
  };
}

export class ArtifactsRepo {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  put(artifact: Artifact): void {
    this.db
      .prepare(
        `INSERT INTO artifacts (id, kind, name, mime_type, size_bytes, uri, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           kind = excluded.kind, name = excluded.name, mime_type = excluded.mime_type,
           size_bytes = excluded.size_bytes, uri = excluded.uri`,
      )
      .run(
        artifact.id,
        artifact.kind,
        artifact.name,
        artifact.mimeType,
        artifact.sizeBytes,
        artifact.uri,
        artifact.createdAt,
      );
  }

  get(id: ArtifactId): Artifact | undefined {
    const row = getRow<ArtifactRow>(this.db.prepare("SELECT * FROM artifacts WHERE id = ?"), id);
    return row === undefined ? undefined : rowToArtifact(row);
  }

  listByKind(kind: Artifact["kind"]): Artifact[] {
    return allRows<ArtifactRow>(
      this.db.prepare("SELECT * FROM artifacts WHERE kind = ? ORDER BY created_at, id"),
      kind,
    ).map(rowToArtifact);
  }

  delete(id: ArtifactId): boolean {
    return this.db.prepare("DELETE FROM artifacts WHERE id = ?").run(id).changes > 0;
  }
}
