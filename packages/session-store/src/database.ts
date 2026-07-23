import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, backup as sqliteBackup } from "node:sqlite";
import { EventLog } from "./events.js";
import { allRows, txt } from "./helpers.js";
import { currentVersion, MIGRATIONS, migrate, type Migration } from "./migrations.js";
import { AgentRunsRepo, AgentsRepo } from "./repos/agents.js";
import { AutomationsRepo, PluginsRepo } from "./repos/automations.js";
import { ApprovalsRepo, ArtifactsRepo, CheckpointsRepo, ToolCallsRepo } from "./repos/execution.js";
import {
  AuditEventsRepo,
  ChannelsRepo,
  NodesRepo,
  PermissionRulesRepo,
  SettingsRepo,
} from "./repos/governance.js";
import { MemoriesRepo } from "./repos/memories.js";
import { ModelsRepo, ModelUsageRepo, ProvidersRepo } from "./repos/models.js";
import { MessagesRepo, SessionsRepo } from "./repos/sessions.js";
import { SkillsRepo } from "./repos/skills.js";
import { TasksRepo } from "./repos/tasks.js";
import { ProfilesRepo, ProjectsRepo, WorkspacesRepo, WorktreesRepo } from "./repos/workspace.js";

export interface OpenDatabaseOptions {
  /** Open read-only; fails if the file does not exist. Skips migrations. */
  readOnly?: boolean;
  /** Busy timeout in ms (how long to wait on a locked database). Default 5000. */
  busyTimeoutMs?: number;
  /** Migration chain to apply; defaults to the built-in MIGRATIONS. */
  migrations?: readonly Migration[];
  /** Migrate to this version instead of the latest. */
  targetVersion?: number;
}

/**
 * The OmniHarness local database: one SQLite file in WAL mode holding sessions,
 * messages, agents, tasks, approvals, skills, memories, automations, settings,
 * the append-only event log, and everything else the daemon persists.
 *
 * Concurrency model (file locking note): SQLite WAL allows many concurrent
 * readers with a single writer. OmniHarness treats the daemon as the single
 * writer — all writes go through this one connection, which serializes them
 * naturally. External processes may open the file read-only safely. No
 * application-level file lock is needed; `busy_timeout` covers transient
 * lock contention (e.g. during `backup()`).
 */
export class OmniDatabase {
  /** Underlying connection, exposed for read-only diagnostics. */
  readonly raw: DatabaseSync;

  readonly profiles: ProfilesRepo;
  readonly projects: ProjectsRepo;
  readonly workspaces: WorkspacesRepo;
  readonly worktrees: WorktreesRepo;
  readonly sessions: SessionsRepo;
  readonly messages: MessagesRepo;
  readonly agents: AgentsRepo;
  readonly agentRuns: AgentRunsRepo;
  readonly tasks: TasksRepo;
  readonly toolCalls: ToolCallsRepo;
  readonly approvals: ApprovalsRepo;
  readonly checkpoints: CheckpointsRepo;
  readonly artifacts: ArtifactsRepo;
  readonly providers: ProvidersRepo;
  readonly models: ModelsRepo;
  readonly modelUsage: ModelUsageRepo;
  readonly skills: SkillsRepo;
  readonly memories: MemoriesRepo;
  readonly automations: AutomationsRepo;
  readonly plugins: PluginsRepo;
  readonly permissionRules: PermissionRulesRepo;
  readonly auditEvents: AuditEventsRepo;
  readonly settings: SettingsRepo;
  readonly channels: ChannelsRepo;
  readonly nodes: NodesRepo;
  readonly events: EventLog;

  constructor(db: DatabaseSync) {
    this.raw = db;
    this.profiles = new ProfilesRepo(db);
    this.projects = new ProjectsRepo(db);
    this.workspaces = new WorkspacesRepo(db);
    this.worktrees = new WorktreesRepo(db);
    this.sessions = new SessionsRepo(db);
    this.messages = new MessagesRepo(db);
    this.agents = new AgentsRepo(db);
    this.agentRuns = new AgentRunsRepo(db);
    this.tasks = new TasksRepo(db);
    this.toolCalls = new ToolCallsRepo(db);
    this.approvals = new ApprovalsRepo(db);
    this.checkpoints = new CheckpointsRepo(db);
    this.artifacts = new ArtifactsRepo(db);
    this.providers = new ProvidersRepo(db);
    this.models = new ModelsRepo(db);
    this.modelUsage = new ModelUsageRepo(db);
    this.skills = new SkillsRepo(db);
    this.memories = new MemoriesRepo(db);
    this.automations = new AutomationsRepo(db);
    this.plugins = new PluginsRepo(db);
    this.permissionRules = new PermissionRulesRepo(db);
    this.auditEvents = new AuditEventsRepo(db);
    this.settings = new SettingsRepo(db);
    this.channels = new ChannelsRepo(db);
    this.nodes = new NodesRepo(db);
    this.events = new EventLog(db);
  }

  /** Run `fn` inside an IMMEDIATE transaction; rolls back on any throw. */
  transaction<T>(fn: () => T): T {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.raw.exec("COMMIT");
      return result;
    } catch (err) {
      this.raw.exec("ROLLBACK");
      throw err;
    }
  }

  /** Current schema version (0 = empty database). */
  schemaVersion(): number {
    return currentVersion(this.raw);
  }

  /**
   * Online backup via SQLite's backup API; safe while the daemon is running.
   * Resolves to the total number of pages copied.
   */
  async backup(targetPath: string): Promise<number> {
    return sqliteBackup(this.raw, targetPath);
  }

  /** Result rows of PRAGMA integrity_check; ["ok"] means healthy. */
  integrityCheck(): string[] {
    return allRows<{ integrity_check: string }>(
      this.raw.prepare("PRAGMA integrity_check"),
    ).map((r) => txt(r.integrity_check));
  }

  /** Dump every user table (and the FTS index) to `<dir>/<table>.json`. */
  exportAll(dir: string): string[] {
    mkdirSync(dir, { recursive: true });
    const tables = allRows<{ name: string }>(
      this.raw.prepare(
        `SELECT name FROM sqlite_master
         WHERE type IN ('table', 'virtual table' /* fts5 shadows report as table */)
           AND name NOT LIKE 'sqlite_%'
           AND name NOT LIKE 'memories_fts_%'
         ORDER BY name`,
      ),
    ).map((r) => txt(r.name));
    const written: string[] = [];
    for (const table of tables) {
      const rows = this.raw.prepare(`SELECT * FROM "${table}"`).all();
      const file = join(dir, `${table}.json`);
      writeFileSync(file, JSON.stringify(rows, null, 2));
      written.push(file);
    }
    return written;
  }

  close(): void {
    this.raw.close();
  }
}

/**
 * Open (and migrate) the OmniHarness database at `path` (`:memory:` works).
 * Applies WAL mode, foreign keys, and a busy timeout, then brings the schema
 * to the target version. Throws MigrationError when the file is newer than
 * this build.
 */
export function openDatabase(path: string, options: OpenDatabaseOptions = {}): OmniDatabase {
  const db = new DatabaseSync(path, {
    readOnly: options.readOnly ?? false,
    timeout: options.busyTimeoutMs ?? 5000,
  });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA synchronous = NORMAL");
  if (options.readOnly !== true) {
    const migrations = options.migrations ?? MIGRATIONS;
    if (options.targetVersion !== undefined) {
      migrate(db, migrations, options.targetVersion);
    } else {
      migrate(db, migrations);
    }
  }
  return new OmniDatabase(db);
}
