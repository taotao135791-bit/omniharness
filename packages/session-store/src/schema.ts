/**
 * Schema v1 DDL. Every complex object (MessagePart[], TokenUsage, PolicyScope,
 * triggers, manifests...) is stored as JSON TEXT; scalar, queryable fields get
 * real columns. All tables are created inside migration 1 (see migrations.ts).
 */
export const SCHEMA_V1_TABLES = [
  "profiles",
  "projects",
  "workspaces",
  "worktrees",
  "sessions",
  "messages",
  "agents",
  "agent_runs",
  "tasks",
  "task_dependencies",
  "tool_calls",
  "approvals",
  "checkpoints",
  "artifacts",
  "providers",
  "models",
  "model_usage",
  "skills",
  "skill_versions",
  "skill_proposals",
  "memories",
  "memories_fts",
  "automations",
  "automation_runs",
  "plugins",
  "channels",
  "nodes",
  "permission_rules",
  "audit_events",
  "settings",
  "event_log",
] as const;

export const SCHEMA_V1_SQL = `
CREATE TABLE profiles (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE projects (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE workspaces (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL,
  roots           TEXT NOT NULL,
  protected_paths TEXT NOT NULL,
  read_only_paths TEXT NOT NULL,
  created_at      TEXT NOT NULL
);

CREATE TABLE worktrees (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id),
  path           TEXT NOT NULL,
  branch         TEXT NOT NULL,
  owner_agent_id TEXT,
  created_at     TEXT NOT NULL
);

CREATE TABLE sessions (
  id              TEXT PRIMARY KEY,
  profile_id      TEXT NOT NULL,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id),
  title           TEXT NOT NULL,
  tags            TEXT NOT NULL,
  status          TEXT NOT NULL,
  head_message_id TEXT,
  model_id        TEXT,
  total_usage     TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX idx_sessions_project  ON sessions(project_id, status);
CREATE INDEX idx_sessions_workspace ON sessions(workspace_id);
CREATE INDEX idx_sessions_updated  ON sessions(updated_at);

CREATE TABLE messages (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  parent_id  TEXT,
  role       TEXT NOT NULL,
  parts      TEXT NOT NULL,
  model_id   TEXT,
  usage      TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_messages_session ON messages(session_id, created_at);
CREATE INDEX idx_messages_parent  ON messages(parent_id);

CREATE TABLE agents (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,
  parent_agent_id TEXT,
  display_name    TEXT NOT NULL,
  status          TEXT NOT NULL,
  allowed_tools   TEXT,
  model_id        TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_agents_session ON agents(session_id);

CREATE TABLE agent_runs (
  id             TEXT PRIMARY KEY,
  agent_id       TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  session_id     TEXT NOT NULL,
  status         TEXT NOT NULL,
  started_at     TEXT NOT NULL,
  ended_at       TEXT,
  usage          TEXT NOT NULL,
  error          TEXT,
  last_event_seq INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_agent_runs_agent   ON agent_runs(agent_id);
CREATE INDEX idx_agent_runs_session ON agent_runs(session_id);

CREATE TABLE tasks (
  id                TEXT PRIMARY KEY,
  parent_task_id    TEXT,
  objective         TEXT NOT NULL,
  status            TEXT NOT NULL,
  assigned_agent_id TEXT,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id),
  worktree_id       TEXT,
  allowed_tools     TEXT,
  budget            TEXT NOT NULL,
  checkpoints       TEXT NOT NULL,
  artifacts         TEXT NOT NULL,
  result            TEXT,
  error             TEXT,
  consumed          TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX idx_tasks_workspace ON tasks(workspace_id, status);

CREATE TABLE task_dependencies (
  task_id            TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_task_id TEXT NOT NULL REFERENCES tasks(id),
  PRIMARY KEY (task_id, depends_on_task_id)
);

CREATE TABLE tool_calls (
  id             TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  agent_run_id   TEXT,
  message_id     TEXT,
  name           TEXT NOT NULL,
  arguments_json TEXT NOT NULL,
  status         TEXT NOT NULL,
  result_json    TEXT,
  error          TEXT,
  capability     TEXT,
  started_at     TEXT NOT NULL,
  ended_at       TEXT
);
CREATE INDEX idx_tool_calls_session ON tool_calls(session_id);
CREATE INDEX idx_tool_calls_run     ON tool_calls(agent_run_id);

CREATE TABLE approvals (
  id            TEXT PRIMARY KEY,
  tool_call_id  TEXT NOT NULL REFERENCES tool_calls(id) ON DELETE CASCADE,
  capability    TEXT NOT NULL,
  risk          TEXT NOT NULL,
  summary       TEXT NOT NULL,
  detail        TEXT NOT NULL,
  status        TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  resolved_at   TEXT,
  resolved_by   TEXT,
  granted_scope TEXT,
  expires_at    TEXT NOT NULL
);
CREATE INDEX idx_approvals_status ON approvals(status);

CREATE TABLE checkpoints (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  ref        TEXT NOT NULL,
  label      TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_checkpoints_session ON checkpoints(session_id);

CREATE TABLE artifacts (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  name       TEXT NOT NULL,
  mime_type  TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  uri        TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE providers (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  base_url      TEXT,
  api_key_ref   TEXT,
  region        TEXT,
  enabled       INTEGER NOT NULL,
  rate_limit_rpm INTEGER NOT NULL,
  timeout_ms    INTEGER NOT NULL,
  max_retries   INTEGER NOT NULL,
  extra_headers TEXT,
  options       TEXT
);

CREATE TABLE models (
  id                      TEXT PRIMARY KEY,
  provider_id             TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  remote_name             TEXT NOT NULL,
  display_name            TEXT NOT NULL,
  capabilities            TEXT NOT NULL,
  cost_per_m_input_tokens  REAL,
  cost_per_m_output_tokens REAL,
  enabled                 INTEGER NOT NULL
);

CREATE TABLE model_usage (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  at            TEXT NOT NULL,
  model_id      TEXT NOT NULL,
  profile_id    TEXT,
  project_id    TEXT,
  session_id    TEXT,
  agent_id      TEXT,
  automation_id TEXT,
  usage         TEXT NOT NULL
);
CREATE INDEX idx_model_usage_at    ON model_usage(at);
CREATE INDEX idx_model_usage_model ON model_usage(model_id, at);

CREATE TABLE skills (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  description           TEXT NOT NULL,
  version               TEXT NOT NULL,
  body                  TEXT NOT NULL,
  resources             TEXT NOT NULL,
  required_capabilities TEXT NOT NULL,
  scope                 TEXT NOT NULL,
  enabled               INTEGER NOT NULL,
  dependencies          TEXT NOT NULL,
  source                TEXT NOT NULL,
  source_path           TEXT,
  created_at            TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_skills_name_version ON skills(name, version);

CREATE TABLE skill_versions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_id   TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  version    TEXT NOT NULL,
  body       TEXT NOT NULL,
  resources  TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (skill_id, version)
);

CREATE TABLE skill_proposals (
  id                 TEXT PRIMARY KEY,
  skill              TEXT NOT NULL,
  diff               TEXT,
  based_on_session_id TEXT NOT NULL,
  status             TEXT NOT NULL,
  test_result        TEXT,
  created_at         TEXT NOT NULL
);

CREATE TABLE memories (
  id                TEXT PRIMARY KEY,
  kind              TEXT NOT NULL,
  profile_id        TEXT NOT NULL,
  project_id        TEXT,
  content           TEXT NOT NULL,
  summary           TEXT NOT NULL,
  source_session_id TEXT,
  created_by        TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  last_verified_at  TEXT NOT NULL,
  confidence        REAL NOT NULL,
  scope             TEXT NOT NULL,
  approved_by_user  INTEGER NOT NULL,
  evidence_refs     TEXT NOT NULL,
  sensitivity       TEXT NOT NULL,
  expires_at        TEXT,
  archived          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_memories_profile ON memories(profile_id, kind);

CREATE VIRTUAL TABLE memories_fts USING fts5(
  summary, content,
  content='memories', content_rowid='rowid'
);

CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, summary, content)
  VALUES (new.rowid, new.summary, new.content);
END;

CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, summary, content)
  VALUES ('delete', old.rowid, old.summary, old.content);
END;

CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, summary, content)
  VALUES ('delete', old.rowid, old.summary, old.content);
  INSERT INTO memories_fts(rowid, summary, content)
  VALUES (new.rowid, new.summary, new.content);
END;

CREATE TABLE automations (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  description     TEXT NOT NULL,
  enabled         INTEGER NOT NULL,
  trigger         TEXT NOT NULL,
  profile_id      TEXT NOT NULL,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id),
  prompt          TEXT NOT NULL,
  skills          TEXT NOT NULL,
  allowed_tools   TEXT NOT NULL,
  network_allowed INTEGER NOT NULL,
  budget          TEXT NOT NULL,
  timeout_ms      INTEGER NOT NULL,
  output          TEXT NOT NULL,
  on_failure      TEXT NOT NULL,
  max_retries     INTEGER NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  last_run_at     TEXT,
  next_run_at     TEXT
);
CREATE INDEX idx_automations_next_run ON automations(enabled, next_run_at);

CREATE TABLE automation_runs (
  id             TEXT PRIMARY KEY,
  automation_id  TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  status         TEXT NOT NULL,
  session_id     TEXT,
  started_at     TEXT NOT NULL,
  ended_at       TEXT,
  result_summary TEXT,
  error          TEXT,
  attempt        INTEGER NOT NULL
);
CREATE INDEX idx_automation_runs_auto ON automation_runs(automation_id, started_at);

CREATE TABLE plugins (
  id                  TEXT PRIMARY KEY,
  manifest            TEXT NOT NULL,
  trust               TEXT NOT NULL,
  enabled             INTEGER NOT NULL,
  installed_at        TEXT NOT NULL,
  granted_permissions TEXT NOT NULL
);

CREATE TABLE channels (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  display_name TEXT NOT NULL,
  config       TEXT NOT NULL,
  enabled      INTEGER NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE TABLE nodes (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  address      TEXT NOT NULL,
  status       TEXT NOT NULL,
  capabilities TEXT NOT NULL,
  last_seen_at TEXT,
  created_at   TEXT NOT NULL
);

CREATE TABLE permission_rules (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  scope       TEXT NOT NULL,
  capability  TEXT NOT NULL,
  decision    TEXT NOT NULL,
  constraints TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_permission_rules_cap ON permission_rules(capability);

CREATE TABLE audit_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         TEXT NOT NULL,
  actor      TEXT NOT NULL,
  action     TEXT NOT NULL,
  detail     TEXT NOT NULL,
  session_id TEXT
);
CREATE INDEX idx_audit_events_at ON audit_events(at);

CREATE TABLE settings (
  scope    TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  key      TEXT NOT NULL,
  value    TEXT NOT NULL,
  PRIMARY KEY (scope, scope_id, key)
);

CREATE TABLE event_log (
  seq     INTEGER PRIMARY KEY AUTOINCREMENT,
  at      TEXT NOT NULL,
  type    TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX idx_event_log_type ON event_log(type, seq);
`;

/** DROP statements for rolling migration 1 back (reverse dependency order). */
export const SCHEMA_V1_DOWN_SQL = `
DROP TRIGGER IF EXISTS memories_au;
DROP TRIGGER IF EXISTS memories_ad;
DROP TRIGGER IF EXISTS memories_ai;
DROP TABLE IF EXISTS event_log;
DROP TABLE IF EXISTS settings;
DROP TABLE IF EXISTS audit_events;
DROP TABLE IF EXISTS permission_rules;
DROP TABLE IF EXISTS nodes;
DROP TABLE IF EXISTS channels;
DROP TABLE IF EXISTS plugins;
DROP TABLE IF EXISTS automation_runs;
DROP TABLE IF EXISTS automations;
DROP TABLE IF EXISTS memories_fts;
DROP TABLE IF EXISTS memories;
DROP TABLE IF EXISTS skill_proposals;
DROP TABLE IF EXISTS skill_versions;
DROP TABLE IF EXISTS skills;
DROP TABLE IF EXISTS model_usage;
DROP TABLE IF EXISTS models;
DROP TABLE IF EXISTS providers;
DROP TABLE IF EXISTS artifacts;
DROP TABLE IF EXISTS checkpoints;
DROP TABLE IF EXISTS approvals;
DROP TABLE IF EXISTS tool_calls;
DROP TABLE IF EXISTS task_dependencies;
DROP TABLE IF EXISTS tasks;
DROP TABLE IF EXISTS agent_runs;
DROP TABLE IF EXISTS agents;
DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS worktrees;
DROP TABLE IF EXISTS workspaces;
DROP TABLE IF EXISTS projects;
DROP TABLE IF EXISTS profiles;
`;
