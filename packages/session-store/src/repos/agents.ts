import type { DatabaseSync } from "node:sqlite";
import type {
  Agent,
  AgentId,
  AgentRun,
  AgentRunId,
  AgentRunStatus,
  IsoTimestamp,
  ModelId,
  SessionId,
  TokenUsage,
} from "@omniharness/shared-types";
import { allRows, getRow, jparse, jstr, num } from "../helpers.js";

interface AgentRow {
  id: string;
  session_id: string;
  kind: string;
  parent_agent_id: string | null;
  display_name: string;
  status: string;
  allowed_tools: string | null;
  model_id: string | null;
  created_at: string;
}

function rowToAgent(r: AgentRow): Agent {
  const agent: Agent = {
    id: r.id as AgentId,
    sessionId: r.session_id as SessionId,
    kind: r.kind as Agent["kind"],
    parentAgentId: r.parent_agent_id as AgentId | null,
    displayName: r.display_name,
    status: r.status as AgentRunStatus,
    allowedTools: r.allowed_tools === null ? null : jparse<string[]>(r.allowed_tools, []),
    createdAt: r.created_at,
  };
  if (r.model_id !== null) agent.modelId = r.model_id as ModelId;
  return agent;
}

export class AgentsRepo {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  put(agent: Agent): void {
    this.db
      .prepare(
        `INSERT INTO agents (id, session_id, kind, parent_agent_id, display_name, status, allowed_tools, model_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           kind = excluded.kind, parent_agent_id = excluded.parent_agent_id,
           display_name = excluded.display_name, status = excluded.status,
           allowed_tools = excluded.allowed_tools, model_id = excluded.model_id`,
      )
      .run(
        agent.id,
        agent.sessionId,
        agent.kind,
        agent.parentAgentId,
        agent.displayName,
        agent.status,
        agent.allowedTools === null ? null : jstr(agent.allowedTools),
        agent.modelId ?? null,
        agent.createdAt,
      );
  }

  get(id: AgentId): Agent | undefined {
    const row = getRow<AgentRow>(this.db.prepare("SELECT * FROM agents WHERE id = ?"), id);
    return row === undefined ? undefined : rowToAgent(row);
  }

  listBySession(sessionId: SessionId): Agent[] {
    return allRows<AgentRow>(
      this.db.prepare("SELECT * FROM agents WHERE session_id = ? ORDER BY created_at, id"),
      sessionId,
    ).map(rowToAgent);
  }

  setStatus(id: AgentId, status: AgentRunStatus): boolean {
    return this.db.prepare("UPDATE agents SET status = ? WHERE id = ?").run(status, id).changes > 0;
  }

  delete(id: AgentId): boolean {
    return this.db.prepare("DELETE FROM agents WHERE id = ?").run(id).changes > 0;
  }
}

interface AgentRunRow {
  id: string;
  agent_id: string;
  session_id: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  usage: string;
  error: string | null;
  last_event_seq: number;
}

function rowToAgentRun(r: AgentRunRow): AgentRun {
  const run: AgentRun = {
    id: r.id as AgentRunId,
    agentId: r.agent_id as AgentId,
    sessionId: r.session_id as SessionId,
    status: r.status as AgentRunStatus,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    usage: jparse<TokenUsage>(r.usage, {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    }),
    lastEventSeq: num(r.last_event_seq),
  };
  if (r.error !== null) run.error = r.error;
  return run;
}

export class AgentRunsRepo {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  put(run: AgentRun): void {
    this.db
      .prepare(
        `INSERT INTO agent_runs (id, agent_id, session_id, status, started_at, ended_at, usage, error, last_event_seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status, ended_at = excluded.ended_at, usage = excluded.usage,
           error = excluded.error, last_event_seq = excluded.last_event_seq`,
      )
      .run(
        run.id,
        run.agentId,
        run.sessionId,
        run.status,
        run.startedAt,
        run.endedAt,
        jstr(run.usage),
        run.error ?? null,
        run.lastEventSeq,
      );
  }

  get(id: AgentRunId): AgentRun | undefined {
    const row = getRow<AgentRunRow>(this.db.prepare("SELECT * FROM agent_runs WHERE id = ?"), id);
    return row === undefined ? undefined : rowToAgentRun(row);
  }

  listByAgent(agentId: AgentId): AgentRun[] {
    return allRows<AgentRunRow>(
      this.db.prepare("SELECT * FROM agent_runs WHERE agent_id = ? ORDER BY started_at, id"),
      agentId,
    ).map(rowToAgentRun);
  }

  listBySession(sessionId: SessionId): AgentRun[] {
    return allRows<AgentRunRow>(
      this.db.prepare("SELECT * FROM agent_runs WHERE session_id = ? ORDER BY started_at, id"),
      sessionId,
    ).map(rowToAgentRun);
  }

  listByStatus(status: AgentRunStatus): AgentRun[] {
    return allRows<AgentRunRow>(
      this.db.prepare("SELECT * FROM agent_runs WHERE status = ? ORDER BY started_at, id"),
      status,
    ).map(rowToAgentRun);
  }

  finish(id: AgentRunId, status: AgentRunStatus, endedAt: IsoTimestamp, error?: string): boolean {
    return (
      this.db
        .prepare("UPDATE agent_runs SET status = ?, ended_at = ?, error = ? WHERE id = ?")
        .run(status, endedAt, error ?? null, id).changes > 0
    );
  }

  delete(id: AgentRunId): boolean {
    return this.db.prepare("DELETE FROM agent_runs WHERE id = ?").run(id).changes > 0;
  }
}
