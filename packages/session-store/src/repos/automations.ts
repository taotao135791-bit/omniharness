import type { DatabaseSync } from "node:sqlite";
import type {
  Automation,
  AutomationId,
  AutomationRun,
  AutomationRunId,
  AutomationRunStatus,
  InstalledPlugin,
  IsoTimestamp,
  PluginId,
  ProfileId,
  SessionId,
  WorkspaceId,
} from "@omniharness/shared-types";
import { nowIso } from "@omniharness/shared-types";
import { allRows, bit, bool, getRow, jparse, jstr, num } from "../helpers.js";

interface AutomationRow {
  id: string;
  name: string;
  description: string;
  enabled: number;
  trigger: string;
  profile_id: string;
  workspace_id: string;
  prompt: string;
  skills: string;
  allowed_tools: string;
  network_allowed: number;
  budget: string;
  timeout_ms: number;
  output: string;
  on_failure: string;
  max_retries: number;
  created_at: string;
  updated_at: string;
  last_run_at: string | null;
  next_run_at: string | null;
}

function rowToAutomation(r: AutomationRow): Automation {
  return {
    id: r.id as AutomationId,
    name: r.name,
    description: r.description,
    enabled: bool(r.enabled),
    trigger: jparse<Automation["trigger"]>(r.trigger, { kind: "manual" }),
    profileId: r.profile_id as ProfileId,
    workspaceId: r.workspace_id as WorkspaceId,
    prompt: r.prompt,
    skills: jparse<string[]>(r.skills, []),
    allowedTools: jparse<string[]>(r.allowed_tools, []),
    networkAllowed: bool(r.network_allowed),
    budget: jparse<Automation["budget"]>(r.budget, {}),
    timeoutMs: num(r.timeout_ms),
    output: jparse<Automation["output"]>(r.output, { kind: "notification" }),
    onFailure: r.on_failure as Automation["onFailure"],
    maxRetries: num(r.max_retries),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastRunAt: r.last_run_at,
    nextRunAt: r.next_run_at,
  };
}

export class AutomationsRepo {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  put(automation: Automation): void {
    this.db
      .prepare(
        `INSERT INTO automations
           (id, name, description, enabled, trigger, profile_id, workspace_id, prompt, skills,
            allowed_tools, network_allowed, budget, timeout_ms, output, on_failure, max_retries,
            created_at, updated_at, last_run_at, next_run_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, description = excluded.description, enabled = excluded.enabled,
           trigger = excluded.trigger, prompt = excluded.prompt, skills = excluded.skills,
           allowed_tools = excluded.allowed_tools, network_allowed = excluded.network_allowed,
           budget = excluded.budget, timeout_ms = excluded.timeout_ms, output = excluded.output,
           on_failure = excluded.on_failure, max_retries = excluded.max_retries,
           updated_at = excluded.updated_at, last_run_at = excluded.last_run_at,
           next_run_at = excluded.next_run_at`,
      )
      .run(
        automation.id,
        automation.name,
        automation.description,
        bit(automation.enabled),
        jstr(automation.trigger),
        automation.profileId,
        automation.workspaceId,
        automation.prompt,
        jstr(automation.skills),
        jstr(automation.allowedTools),
        bit(automation.networkAllowed),
        jstr(automation.budget),
        automation.timeoutMs,
        jstr(automation.output),
        automation.onFailure,
        automation.maxRetries,
        automation.createdAt,
        automation.updatedAt,
        automation.lastRunAt,
        automation.nextRunAt,
      );
  }

  get(id: AutomationId): Automation | undefined {
    const row = getRow<AutomationRow>(
      this.db.prepare("SELECT * FROM automations WHERE id = ?"),
      id,
    );
    return row === undefined ? undefined : rowToAutomation(row);
  }

  list(enabledOnly = false): Automation[] {
    const rows = enabledOnly
      ? allRows<AutomationRow>(
          this.db.prepare("SELECT * FROM automations WHERE enabled = 1 ORDER BY name, id"),
        )
      : allRows<AutomationRow>(this.db.prepare("SELECT * FROM automations ORDER BY name, id"));
    return rows.map(rowToAutomation);
  }

  /** Enabled automations whose next run is due at or before `at`. */
  listDue(at: IsoTimestamp): Automation[] {
    return allRows<AutomationRow>(
      this.db.prepare(
        "SELECT * FROM automations WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at",
      ),
      at,
    ).map(rowToAutomation);
  }

  markRun(id: AutomationId, lastRunAt: IsoTimestamp, nextRunAt: IsoTimestamp | null): boolean {
    return (
      this.db
        .prepare(
          "UPDATE automations SET last_run_at = ?, next_run_at = ?, updated_at = ? WHERE id = ?",
        )
        .run(lastRunAt, nextRunAt, nowIso(), id).changes > 0
    );
  }

  setEnabled(id: AutomationId, enabled: boolean): boolean {
    return (
      this.db
        .prepare("UPDATE automations SET enabled = ?, updated_at = ? WHERE id = ?")
        .run(bit(enabled), nowIso(), id).changes > 0
    );
  }

  delete(id: AutomationId): boolean {
    return this.db.prepare("DELETE FROM automations WHERE id = ?").run(id).changes > 0;
  }

  // ---- runs ----

  putRun(run: AutomationRun): void {
    this.db
      .prepare(
        `INSERT INTO automation_runs
           (id, automation_id, status, session_id, started_at, ended_at, result_summary, error, attempt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status, session_id = excluded.session_id, ended_at = excluded.ended_at,
           result_summary = excluded.result_summary, error = excluded.error,
           attempt = excluded.attempt`,
      )
      .run(
        run.id,
        run.automationId,
        run.status,
        run.sessionId,
        run.startedAt,
        run.endedAt,
        run.resultSummary ?? null,
        run.error ?? null,
        run.attempt,
      );
  }

  getRun(id: AutomationRunId): AutomationRun | undefined {
    const row = getRow<AutomationRunRow>(
      this.db.prepare("SELECT * FROM automation_runs WHERE id = ?"),
      id,
    );
    return row === undefined ? undefined : rowToAutomationRun(row);
  }

  listRuns(automationId: AutomationId, status?: AutomationRunStatus): AutomationRun[] {
    const rows =
      status === undefined
        ? allRows<AutomationRunRow>(
            this.db.prepare(
              "SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY started_at DESC, id",
            ),
            automationId,
          )
        : allRows<AutomationRunRow>(
            this.db.prepare(
              "SELECT * FROM automation_runs WHERE automation_id = ? AND status = ? ORDER BY started_at DESC, id",
            ),
            automationId,
            status,
          );
    return rows.map(rowToAutomationRun);
  }

  deleteRun(id: AutomationRunId): boolean {
    return this.db.prepare("DELETE FROM automation_runs WHERE id = ?").run(id).changes > 0;
  }
}

interface AutomationRunRow {
  id: string;
  automation_id: string;
  status: string;
  session_id: string | null;
  started_at: string;
  ended_at: string | null;
  result_summary: string | null;
  error: string | null;
  attempt: number;
}

function rowToAutomationRun(r: AutomationRunRow): AutomationRun {
  const run: AutomationRun = {
    id: r.id as AutomationRunId,
    automationId: r.automation_id as AutomationId,
    status: r.status as AutomationRunStatus,
    sessionId: r.session_id as SessionId | null,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    attempt: num(r.attempt),
  };
  if (r.result_summary !== null) run.resultSummary = r.result_summary;
  if (r.error !== null) run.error = r.error;
  return run;
}

interface PluginRow {
  id: string;
  manifest: string;
  trust: string;
  enabled: number;
  installed_at: string;
  granted_permissions: string;
}

function rowToPlugin(r: PluginRow): InstalledPlugin {
  return {
    manifest: jparse<InstalledPlugin["manifest"]>(r.manifest, {} as InstalledPlugin["manifest"]),
    trust: r.trust as InstalledPlugin["trust"],
    enabled: bool(r.enabled),
    installedAt: r.installed_at,
    grantedPermissions: jparse<InstalledPlugin["grantedPermissions"]>(r.granted_permissions, {
      capabilities: [],
      tools: [],
      uiExtensions: [],
      registersProviders: false,
      secrets: [],
      networkDomains: [],
    }),
  };
}

export class PluginsRepo {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  put(plugin: InstalledPlugin): void {
    this.db
      .prepare(
        `INSERT INTO plugins (id, manifest, trust, enabled, installed_at, granted_permissions)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           manifest = excluded.manifest, trust = excluded.trust, enabled = excluded.enabled,
           granted_permissions = excluded.granted_permissions`,
      )
      .run(
        plugin.manifest.id,
        jstr(plugin.manifest),
        plugin.trust,
        bit(plugin.enabled),
        plugin.installedAt,
        jstr(plugin.grantedPermissions),
      );
  }

  get(id: PluginId): InstalledPlugin | undefined {
    const row = getRow<PluginRow>(this.db.prepare("SELECT * FROM plugins WHERE id = ?"), id);
    return row === undefined ? undefined : rowToPlugin(row);
  }

  list(enabledOnly = false): InstalledPlugin[] {
    const rows = enabledOnly
      ? allRows<PluginRow>(this.db.prepare("SELECT * FROM plugins WHERE enabled = 1 ORDER BY id"))
      : allRows<PluginRow>(this.db.prepare("SELECT * FROM plugins ORDER BY id"));
    return rows.map(rowToPlugin);
  }

  setEnabled(id: PluginId, enabled: boolean): boolean {
    return (
      this.db.prepare("UPDATE plugins SET enabled = ? WHERE id = ?").run(bit(enabled), id).changes >
      0
    );
  }

  delete(id: PluginId): boolean {
    return this.db.prepare("DELETE FROM plugins WHERE id = ?").run(id).changes > 0;
  }
}
