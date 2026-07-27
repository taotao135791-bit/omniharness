import type { DatabaseSync } from "node:sqlite";
import type {
  Message,
  MessageId,
  ModelId,
  ProfileId,
  ProjectId,
  Session,
  SessionId,
  SessionStatus,
  TokenUsage,
  WorkspaceId,
} from "@omniharness/shared-types";
import { nowIso } from "@omniharness/shared-types";
import { allRows, getRow, jparse, jstr, num } from "../helpers.js";
import type { Page, Pagination } from "../types.js";

interface SessionRow {
  id: string;
  profile_id: string;
  project_id: string;
  workspace_id: string;
  title: string;
  tags: string;
  status: string;
  head_message_id: string | null;
  model_id: string | null;
  total_usage: string;
  created_at: string;
  updated_at: string;
}

function rowToSession(r: SessionRow): Session {
  const session: Session = {
    id: r.id as SessionId,
    profileId: r.profile_id as ProfileId,
    projectId: r.project_id as ProjectId,
    workspaceId: r.workspace_id as WorkspaceId,
    title: r.title,
    tags: jparse<string[]>(r.tags, []),
    status: r.status as SessionStatus,
    headMessageId: r.head_message_id as MessageId | null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    totalUsage: jparse<TokenUsage>(r.total_usage, {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    }),
  };
  if (r.model_id !== null) session.modelId = r.model_id as ModelId;
  return session;
}

/** Filters for {@link SessionsRepo.list}. `search` matches titles case-insensitively. */
export interface SessionListFilter extends Pagination {
  profileId?: ProfileId;
  projectId?: ProjectId;
  workspaceId?: WorkspaceId;
  status?: SessionStatus;
  tag?: string;
  search?: string;
}

export class SessionsRepo {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  create(session: Session): void {
    this.db
      .prepare(
        `INSERT INTO sessions
           (id, profile_id, project_id, workspace_id, title, tags, status, head_message_id, model_id, total_usage, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        session.profileId,
        session.projectId,
        session.workspaceId,
        session.title,
        jstr(session.tags),
        session.status,
        session.headMessageId,
        session.modelId ?? null,
        jstr(session.totalUsage),
        session.createdAt,
        session.updatedAt,
      );
  }

  get(id: SessionId): Session | undefined {
    const row = getRow<SessionRow>(this.db.prepare("SELECT * FROM sessions WHERE id = ?"), id);
    return row === undefined ? undefined : rowToSession(row);
  }

  list(filter: SessionListFilter = {}): Page<Session> {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (filter.profileId !== undefined) {
      where.push("profile_id = ?");
      params.push(filter.profileId);
    }
    if (filter.projectId !== undefined) {
      where.push("project_id = ?");
      params.push(filter.projectId);
    }
    if (filter.workspaceId !== undefined) {
      where.push("workspace_id = ?");
      params.push(filter.workspaceId);
    }
    if (filter.status !== undefined) {
      where.push("status = ?");
      params.push(filter.status);
    }
    if (filter.tag !== undefined) {
      // tags is a JSON array of strings; match the exact element.
      where.push("EXISTS (SELECT 1 FROM json_each(sessions.tags) WHERE json_each.value = ?)");
      params.push(filter.tag);
    }
    if (filter.search !== undefined) {
      where.push("LOWER(title) LIKE ?");
      params.push(`%${filter.search.toLowerCase()}%`);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const limit = filter.limit ?? 50;
    const offset = filter.offset ?? 0;

    const totalRow = getRow<{ c: number }>(
      this.db.prepare(`SELECT COUNT(*) AS c FROM sessions ${clause}`),
      ...params,
    );
    const rows = allRows<SessionRow>(
      this.db.prepare(
        `SELECT * FROM sessions ${clause} ORDER BY updated_at DESC, id LIMIT ? OFFSET ?`,
      ),
      ...params,
      limit,
      offset,
    );
    return {
      items: rows.map(rowToSession),
      total: totalRow === undefined ? 0 : num(totalRow.c),
      limit,
      offset,
    };
  }

  rename(id: SessionId, title: string): boolean {
    return (
      this.db
        .prepare("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?")
        .run(title, nowIso(), id).changes > 0
    );
  }

  setTags(id: SessionId, tags: string[]): boolean {
    return (
      this.db
        .prepare("UPDATE sessions SET tags = ?, updated_at = ? WHERE id = ?")
        .run(jstr(tags), nowIso(), id).changes > 0
    );
  }

  setStatus(id: SessionId, status: SessionStatus): boolean {
    return (
      this.db
        .prepare("UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?")
        .run(status, nowIso(), id).changes > 0
    );
  }

  archive(id: SessionId): boolean {
    return this.setStatus(id, "archived");
  }

  /** Soft delete: keeps rows for audit; messages stay reachable. */
  softDelete(id: SessionId): boolean {
    return this.setStatus(id, "deleted");
  }

  setHead(id: SessionId, headMessageId: MessageId | null): boolean {
    return (
      this.db
        .prepare("UPDATE sessions SET head_message_id = ?, updated_at = ? WHERE id = ?")
        .run(headMessageId, nowIso(), id).changes > 0
    );
  }

  setModel(id: SessionId, modelId: ModelId | null): boolean {
    return (
      this.db
        .prepare("UPDATE sessions SET model_id = ?, updated_at = ? WHERE id = ?")
        .run(modelId, nowIso(), id).changes > 0
    );
  }

  setTotalUsage(id: SessionId, usage: TokenUsage): boolean {
    return (
      this.db
        .prepare("UPDATE sessions SET total_usage = ?, updated_at = ? WHERE id = ?")
        .run(jstr(usage), nowIso(), id).changes > 0
    );
  }

  /** Hard delete; cascades to messages/agents/runs/tool_calls/checkpoints. */
  delete(id: SessionId): boolean {
    return this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id).changes > 0;
  }
}

interface MessageRow {
  id: string;
  session_id: string;
  parent_id: string | null;
  role: string;
  parts: string;
  model_id: string | null;
  usage: string | null;
  created_at: string;
}

function rowToMessage(r: MessageRow): Message {
  const message: Message = {
    id: r.id as MessageId,
    sessionId: r.session_id as SessionId,
    parentId: r.parent_id as MessageId | null,
    role: r.role as Message["role"],
    parts: jparse<Message["parts"]>(r.parts, []),
    createdAt: r.created_at,
  };
  if (r.model_id !== null) message.modelId = r.model_id as ModelId;
  if (r.usage !== null)
    message.usage = jparse<TokenUsage>(r.usage, {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  return message;
}

export class MessagesRepo {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  add(message: Message): void {
    this.db
      .prepare(
        `INSERT INTO messages (id, session_id, parent_id, role, parts, model_id, usage, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        message.id,
        message.sessionId,
        message.parentId,
        message.role,
        jstr(message.parts),
        message.modelId ?? null,
        message.usage === undefined ? null : jstr(message.usage),
        message.createdAt,
      );
  }

  get(id: MessageId): Message | undefined {
    const row = getRow<MessageRow>(this.db.prepare("SELECT * FROM messages WHERE id = ?"), id);
    return row === undefined ? undefined : rowToMessage(row);
  }

  /** All messages of a session, in creation order. */
  listBySession(sessionId: SessionId, pagination: Pagination = {}): Page<Message> {
    const limit = pagination.limit ?? 200;
    const offset = pagination.offset ?? 0;
    const totalRow = getRow<{ c: number }>(
      this.db.prepare("SELECT COUNT(*) AS c FROM messages WHERE session_id = ?"),
      sessionId,
    );
    const rows = allRows<MessageRow>(
      this.db.prepare(
        "SELECT * FROM messages WHERE session_id = ? ORDER BY created_at, id LIMIT ? OFFSET ?",
      ),
      sessionId,
      limit,
      offset,
    );
    return {
      items: rows.map(rowToMessage),
      total: totalRow === undefined ? 0 : num(totalRow.c),
      limit,
      offset,
    };
  }

  /** Direct children of a message — i.e. the branches starting at that node. */
  branches(parentId: MessageId): Message[] {
    return allRows<MessageRow>(
      this.db.prepare("SELECT * FROM messages WHERE parent_id = ? ORDER BY created_at, id"),
      parentId,
    ).map(rowToMessage);
  }

  /**
   * Walk from a message to the root, returning the chain root-first —
   * the linear conversation view of one branch.
   */
  pathToRoot(messageId: MessageId): Message[] {
    const chain: Message[] = [];
    let cursor: MessageId | null = messageId;
    while (cursor !== null) {
      const msg: Message | undefined = this.get(cursor);
      if (msg === undefined) break;
      chain.unshift(msg);
      cursor = msg.parentId;
    }
    return chain;
  }

  delete(id: MessageId): boolean {
    return this.db.prepare("DELETE FROM messages WHERE id = ?").run(id).changes > 0;
  }
}
