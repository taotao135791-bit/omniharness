import type { DatabaseSync } from "node:sqlite";
import type {
  Capability,
  ChannelId,
  IsoTimestamp,
  NodeId,
  PolicyRule,
  PolicyScope,
  SessionId,
} from "@omniharness/shared-types";
import { nowIso } from "@omniharness/shared-types";
import { allRows, bit, bool, getRow, jparse, jstr, num } from "../helpers.js";
import type {
  AuditEventRecord,
  ChannelRecord,
  NodeRecord,
  PermissionRuleRecord,
  SettingEntry,
  SettingsScope,
} from "../types.js";

interface PermissionRuleRow {
  id: number;
  scope: string;
  capability: string;
  decision: string;
  constraints: string | null;
  created_at: string;
}

function rowToPermissionRule(r: PermissionRuleRow): PermissionRuleRecord {
  const rule: PolicyRule = {
    capability: r.capability as Capability,
    decision: r.decision as PolicyRule["decision"],
  };
  if (r.constraints !== null) {
    rule.constraints = jparse<NonNullable<PolicyRule["constraints"]>>(r.constraints, {});
  }
  return {
    id: num(r.id),
    scope: jparse<PolicyScope>(r.scope, { kind: "product_default" }),
    rule,
    createdAt: r.created_at,
  };
}

export class PermissionRulesRepo {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** Add a rule; returns its assigned id. */
  add(scope: PolicyScope, rule: PolicyRule, createdAt: IsoTimestamp = nowIso()): number {
    const res = this.db
      .prepare(
        `INSERT INTO permission_rules (scope, capability, decision, constraints, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        jstr(scope),
        rule.capability,
        rule.decision,
        rule.constraints === undefined ? null : jstr(rule.constraints),
        createdAt,
      );
    return Number(res.lastInsertRowid);
  }

  get(id: number): PermissionRuleRecord | undefined {
    const row = getRow<PermissionRuleRow>(
      this.db.prepare("SELECT * FROM permission_rules WHERE id = ?"),
      id,
    );
    return row === undefined ? undefined : rowToPermissionRule(row);
  }

  list(capability?: Capability): PermissionRuleRecord[] {
    const rows =
      capability === undefined
        ? allRows<PermissionRuleRow>(this.db.prepare("SELECT * FROM permission_rules ORDER BY id"))
        : allRows<PermissionRuleRow>(
            this.db.prepare("SELECT * FROM permission_rules WHERE capability = ? ORDER BY id"),
            capability,
          );
    return rows.map(rowToPermissionRule);
  }

  delete(id: number): boolean {
    return this.db.prepare("DELETE FROM permission_rules WHERE id = ?").run(id).changes > 0;
  }
}

interface AuditEventRow {
  id: number;
  at: string;
  actor: string;
  action: string;
  detail: string;
  session_id: string | null;
}

function rowToAuditEvent(r: AuditEventRow): AuditEventRecord {
  return {
    id: num(r.id),
    at: r.at,
    actor: r.actor,
    action: r.action,
    detail: jparse<Record<string, string>>(r.detail, {}),
    sessionId: r.session_id as SessionId | null,
  };
}

export class AuditEventsRepo {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** Append an audit entry; returns its assigned id. */
  record(
    actor: string,
    action: string,
    detail: Record<string, string> = {},
    sessionId: SessionId | null = null,
    at: IsoTimestamp = nowIso(),
  ): number {
    const res = this.db
      .prepare(
        "INSERT INTO audit_events (at, actor, action, detail, session_id) VALUES (?, ?, ?, ?, ?)",
      )
      .run(at, actor, action, jstr(detail), sessionId);
    return Number(res.lastInsertRowid);
  }

  get(id: number): AuditEventRecord | undefined {
    const row = getRow<AuditEventRow>(
      this.db.prepare("SELECT * FROM audit_events WHERE id = ?"),
      id,
    );
    return row === undefined ? undefined : rowToAuditEvent(row);
  }

  list(
    options: { since?: IsoTimestamp; action?: string; limit?: number } = {},
  ): AuditEventRecord[] {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (options.since !== undefined) {
      where.push("at >= ?");
      params.push(options.since);
    }
    if (options.action !== undefined) {
      where.push("action = ?");
      params.push(options.action);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const limit = options.limit ?? 500;
    return allRows<AuditEventRow>(
      this.db.prepare(`SELECT * FROM audit_events ${clause} ORDER BY id DESC LIMIT ?`),
      ...params,
      limit,
    ).map(rowToAuditEvent);
  }
}

export class SettingsRepo {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** Read one setting; undefined when absent. Values are JSON round-tripped. */
  get(scope: SettingsScope, scopeId: string, key: string): unknown {
    const row = getRow<{ value: string }>(
      this.db.prepare("SELECT value FROM settings WHERE scope = ? AND scope_id = ? AND key = ?"),
      scope,
      scopeId,
      key,
    );
    return row === undefined ? undefined : jparse<unknown>(row.value, null);
  }

  /** Typed convenience accessor. */
  getAs<T>(scope: SettingsScope, scopeId: string, key: string): T | undefined {
    const value = this.get(scope, scopeId, key);
    return value === undefined ? undefined : (value as T);
  }

  set(scope: SettingsScope, scopeId: string, key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO settings (scope, scope_id, key, value) VALUES (?, ?, ?, ?)
         ON CONFLICT(scope, scope_id, key) DO UPDATE SET value = excluded.value`,
      )
      .run(scope, scopeId, key, jstr(value));
  }

  delete(scope: SettingsScope, scopeId: string, key: string): boolean {
    return (
      this.db
        .prepare("DELETE FROM settings WHERE scope = ? AND scope_id = ? AND key = ?")
        .run(scope, scopeId, key).changes > 0
    );
  }

  /** All entries under one scope+scopeId, ordered by key. */
  list(scope: SettingsScope, scopeId: string): SettingEntry[] {
    interface EntryRow {
      key: string;
      value: string;
    }
    return allRows<EntryRow>(
      this.db.prepare(
        "SELECT key, value FROM settings WHERE scope = ? AND scope_id = ? ORDER BY key",
      ),
      scope,
      scopeId,
    ).map((r) => ({ scope, scopeId, key: r.key, value: jparse<unknown>(r.value, null) }));
  }
}

interface ChannelRow {
  id: string;
  kind: string;
  display_name: string;
  config: string;
  enabled: number;
  created_at: string;
}

function rowToChannel(r: ChannelRow): ChannelRecord {
  return {
    id: r.id as ChannelId,
    kind: r.kind,
    displayName: r.display_name,
    config: jparse<Record<string, unknown>>(r.config, {}),
    enabled: bool(r.enabled),
    createdAt: r.created_at,
  };
}

export class ChannelsRepo {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  put(channel: ChannelRecord): void {
    this.db
      .prepare(
        `INSERT INTO channels (id, kind, display_name, config, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           kind = excluded.kind, display_name = excluded.display_name,
           config = excluded.config, enabled = excluded.enabled`,
      )
      .run(
        channel.id,
        channel.kind,
        channel.displayName,
        jstr(channel.config),
        bit(channel.enabled),
        channel.createdAt,
      );
  }

  get(id: ChannelId): ChannelRecord | undefined {
    const row = getRow<ChannelRow>(this.db.prepare("SELECT * FROM channels WHERE id = ?"), id);
    return row === undefined ? undefined : rowToChannel(row);
  }

  list(enabledOnly = false): ChannelRecord[] {
    const rows = enabledOnly
      ? allRows<ChannelRow>(
          this.db.prepare("SELECT * FROM channels WHERE enabled = 1 ORDER BY display_name, id"),
        )
      : allRows<ChannelRow>(this.db.prepare("SELECT * FROM channels ORDER BY display_name, id"));
    return rows.map(rowToChannel);
  }

  delete(id: ChannelId): boolean {
    return this.db.prepare("DELETE FROM channels WHERE id = ?").run(id).changes > 0;
  }
}

interface NodeRow {
  id: string;
  name: string;
  address: string;
  status: string;
  capabilities: string;
  last_seen_at: string | null;
  created_at: string;
}

function rowToNode(r: NodeRow): NodeRecord {
  return {
    id: r.id as NodeId,
    name: r.name,
    address: r.address,
    status: r.status as NodeRecord["status"],
    capabilities: jparse<string[]>(r.capabilities, []),
    lastSeenAt: r.last_seen_at,
    createdAt: r.created_at,
  };
}

export class NodesRepo {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  put(node: NodeRecord): void {
    this.db
      .prepare(
        `INSERT INTO nodes (id, name, address, status, capabilities, last_seen_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, address = excluded.address, status = excluded.status,
           capabilities = excluded.capabilities, last_seen_at = excluded.last_seen_at`,
      )
      .run(
        node.id,
        node.name,
        node.address,
        node.status,
        jstr(node.capabilities),
        node.lastSeenAt,
        node.createdAt,
      );
  }

  get(id: NodeId): NodeRecord | undefined {
    const row = getRow<NodeRow>(this.db.prepare("SELECT * FROM nodes WHERE id = ?"), id);
    return row === undefined ? undefined : rowToNode(row);
  }

  list(): NodeRecord[] {
    return allRows<NodeRow>(this.db.prepare("SELECT * FROM nodes ORDER BY name, id")).map(
      rowToNode,
    );
  }

  heartbeat(id: NodeId, at: IsoTimestamp = nowIso()): boolean {
    return (
      this.db
        .prepare("UPDATE nodes SET last_seen_at = ?, status = 'online' WHERE id = ?")
        .run(at, id).changes > 0
    );
  }

  delete(id: NodeId): boolean {
    return this.db.prepare("DELETE FROM nodes WHERE id = ?").run(id).changes > 0;
  }
}
