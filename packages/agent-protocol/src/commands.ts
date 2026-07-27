import type {
  Agent,
  AgentRun,
  AgentTask,
  ApprovalDecision,
  ApprovalRequest,
  Artifact,
  Automation,
  AutomationRun,
  Checkpoint,
  InstalledPlugin,
  MemoryEntry,
  MemorySearchResult,
  Message,
  ModelDefinition,
  ModelRole,
  Profile,
  Project,
  ProviderConfig,
  ProviderKind,
  Session,
  SessionId,
  SkillDefinition,
  SkillProposal,
  TaskId,
  TokenUsage,
  Workspace,
  Worktree,
} from "./commands-types.js";

/**
 * Versioned command catalog. Each command maps to { params, result }.
 * The daemon is the only implementor; TUI/GUI/CLI/SDK all go through this contract.
 */
export interface CommandMap {
  // ── system ──────────────────────────────────────────────────────────────
  "system.ping": {
    params: Record<string, never>;
    result: { ok: true; version: string; uptimeMs: number };
  };
  "system.diagnostics": { params: Record<string, never>; result: DiagnosticsReport };
  "system.shutdown": { params: { reason?: string }; result: { ok: true } };
  "events.since": {
    params: { seq: number; limit?: number };
    result: { events: unknown[]; latestSeq: number };
  };

  // ── profiles / projects / workspaces ────────────────────────────────────
  "profile.list": { params: Record<string, never>; result: { profiles: Profile[] } };
  "profile.create": { params: { name: string }; result: { profile: Profile } };
  "project.list": { params: { profileId?: string }; result: { projects: Project[] } };
  "project.create": { params: { name: string; profileId?: string }; result: { project: Project } };
  "workspace.register": {
    params: { projectId: string; roots: string[]; name?: string };
    result: { workspace: Workspace };
  };
  "workspace.list": { params: { projectId?: string }; result: { workspaces: Workspace[] } };
  "workspace.status": { params: { workspaceId: string }; result: WorkspaceStatus };
  "worktree.create": {
    params: { workspaceId: string; branch?: string; ownerAgentId?: string };
    result: { worktree: Worktree };
  };
  "worktree.list": { params: { workspaceId: string }; result: { worktrees: Worktree[] } };
  "worktree.remove": { params: { worktreeId: string; force?: boolean }; result: { ok: true } };

  // ── sessions ────────────────────────────────────────────────────────────
  "session.create": {
    params: { workspaceId: string; title?: string; profileId?: string; modelId?: string };
    result: { session: Session };
  };
  "session.get": { params: { sessionId: SessionId }; result: { session: Session } };
  "session.list": {
    params: {
      workspaceId?: string;
      profileId?: string;
      status?: string;
      limit?: number;
      offset?: number;
    };
    result: { sessions: Session[]; total: number };
  };
  "session.rename": {
    params: { sessionId: SessionId; title: string };
    result: { session: Session };
  };
  "session.setTags": {
    params: { sessionId: SessionId; tags: string[] };
    result: { session: Session };
  };
  "session.archive": { params: { sessionId: SessionId }; result: { ok: true } };
  "session.messages": {
    params: { sessionId: SessionId; limit?: number; beforeMessageId?: string };
    result: { messages: Message[] };
  };
  "session.branch": {
    params: { sessionId: SessionId; fromMessageId: string };
    result: { session: Session };
  };
  "session.export": {
    params: { sessionId: SessionId; format: "json" | "markdown" };
    result: { artifact: Artifact };
  };
  "session.import": {
    params: { source: "pi" | "hermes" | "omniharness"; path: string; workspaceId: string };
    result: { session: Session };
  };

  // ── agent runs ──────────────────────────────────────────────────────────
  "run.start": {
    params: {
      sessionId: SessionId;
      input: string;
      attachments?: Array<{ uri: string; mimeType: string; name: string }>;
      modelId?: string;
      agentKind?: string;
    };
    result: { runId: string };
  };
  "run.steer": { params: { runId: string; input: string }; result: { ok: true } };
  "run.enqueueFollowUp": {
    params: { sessionId: SessionId; input: string };
    result: { queuePosition: number };
  };
  "run.interrupt": { params: { runId: string }; result: { ok: true } };
  "run.resume": { params: { runId: string }; result: { ok: true } };
  "run.retry": { params: { runId: string }; result: { runId: string } };
  "run.list": { params: { sessionId: SessionId }; result: { runs: AgentRun[] } };
  "agent.list": { params: { sessionId?: SessionId }; result: { agents: Agent[] } };

  // ── models / providers ──────────────────────────────────────────────────
  "provider.list": { params: Record<string, never>; result: { providers: ProviderConfig[] } };
  "provider.add": {
    params: {
      kind: ProviderKind;
      displayName: string;
      baseUrl?: string;
      apiKey?: string;
      options?: Record<string, string>;
    };
    result: { provider: ProviderConfig };
  };
  "provider.remove": { params: { providerId: string }; result: { ok: true } };
  "provider.test": {
    params: { providerId: string };
    result: { ok: boolean; latencyMs: number; error?: string; models?: string[] };
  };
  "model.list": {
    params: { providerId?: string; capabilityFilter?: string[] };
    result: { models: ModelDefinition[] };
  };
  "model.setRoleBinding": {
    params: {
      role: ModelRole;
      modelId: string | null;
      scope?: "profile" | "session";
      sessionId?: SessionId;
    };
    result: { ok: true };
  };
  "model.getRoleBindings": {
    params: { sessionId?: SessionId };
    result: { bindings: Partial<Record<ModelRole, string>> };
  };
  "usage.summary": {
    params: { since?: string; groupBy?: "model" | "project" | "agent" | "automation" };
    result: { usage: UsageBucket[] };
  };

  // ── tools / approvals / policy ──────────────────────────────────────────
  "tool.list": { params: Record<string, never>; result: { tools: ToolDescriptor[] } };
  "approval.list": {
    params: { status?: string; limit?: number };
    result: { approvals: ApprovalRequest[] };
  };
  "approval.resolve": {
    params: { approvalId: string; decision: ApprovalDecision; rememberScope?: string };
    result: { approval: ApprovalRequest };
  };
  "policy.get": { params: { scope?: string; scopeId?: string }; result: { rules: unknown[] } };
  "policy.set": {
    params: { scope: string; scopeId?: string; rules: unknown[] };
    result: { ok: true };
  };

  // ── diff / checkpoints / artifacts ──────────────────────────────────────
  "diff.get": {
    params: { workspaceId?: string; worktreeId?: string; sessionId?: SessionId };
    result: DiffResult;
  };
  "diff.accept": {
    params: { worktreeId?: string; sessionId?: SessionId; file?: string; hunkIndex?: number };
    result: { ok: true };
  };
  "diff.reject": {
    params: { worktreeId?: string; sessionId?: SessionId; file?: string; hunkIndex?: number };
    result: { ok: true };
  };
  "checkpoint.create": {
    params: { sessionId: SessionId; label?: string };
    result: { checkpoint: Checkpoint };
  };
  "checkpoint.list": { params: { sessionId: SessionId }; result: { checkpoints: Checkpoint[] } };
  "checkpoint.restore": { params: { checkpointId: string }; result: { ok: true } };
  "artifact.list": {
    params: { sessionId?: SessionId; kind?: string; limit?: number };
    result: { artifacts: Artifact[] };
  };

  // ── tasks (multi-agent orchestration) ───────────────────────────────────
  "task.create": {
    params: {
      objective: string;
      sessionId: SessionId;
      parentTaskId?: TaskId;
      dependencies?: TaskId[];
      allowedTools?: string[];
      budget?: Record<string, number>;
    };
    result: { task: AgentTask };
  };
  "task.list": {
    params: { sessionId?: SessionId; status?: string };
    result: { tasks: AgentTask[] };
  };
  "task.pause": { params: { taskId: TaskId }; result: { ok: true } };
  "task.resume": { params: { taskId: TaskId }; result: { ok: true } };
  "task.cancel": { params: { taskId: TaskId }; result: { ok: true } };
  "task.reassign": { params: { taskId: TaskId; agentKind: string }; result: { ok: true } };

  // ── memory ──────────────────────────────────────────────────────────────
  "memory.search": {
    params: {
      text: string;
      profileId?: string;
      projectId?: string;
      kinds?: string[];
      limit?: number;
      includePending?: boolean;
    };
    result: { results: MemorySearchResult[] };
  };
  "memory.list": {
    params: { profileId?: string; approvedOnly?: boolean; limit?: number; offset?: number };
    result: { memories: MemoryEntry[]; total: number };
  };
  "memory.add": {
    params: { content: string; kind: string; profileId?: string; projectId?: string };
    result: { memory: MemoryEntry };
  };
  "memory.approve": { params: { memoryId: string }; result: { ok: true } };
  "memory.reject": { params: { memoryId: string }; result: { ok: true } };
  "memory.delete": { params: { memoryId: string }; result: { ok: true } };

  // ── skills ──────────────────────────────────────────────────────────────
  "skill.list": {
    params: { scope?: string; enabledOnly?: boolean };
    result: { skills: SkillDefinition[] };
  };
  "skill.get": { params: { skillId: string }; result: { skill: SkillDefinition } };
  "skill.setEnabled": { params: { skillId: string; enabled: boolean }; result: { ok: true } };
  "skill.install": {
    params: { source: "local" | "registry" | "git"; ref: string; scope?: string };
    result: { skill: SkillDefinition };
  };
  "skill.proposals": { params: { status?: string }; result: { proposals: SkillProposal[] } };
  "skill.approveProposal": { params: { proposalId: string }; result: { skill: SkillDefinition } };
  "skill.rejectProposal": { params: { proposalId: string; reason?: string }; result: { ok: true } };

  // ── automations ─────────────────────────────────────────────────────────
  "automation.create": {
    params: {
      automation: Omit<Automation, "id" | "createdAt" | "updatedAt" | "lastRunAt" | "nextRunAt">;
    };
    result: { automation: Automation };
  };
  "automation.list": { params: { enabledOnly?: boolean }; result: { automations: Automation[] } };
  "automation.setEnabled": {
    params: { automationId: string; enabled: boolean };
    result: { ok: true };
  };
  "automation.runNow": { params: { automationId: string }; result: { runId: string } };
  "automation.runs": {
    params: { automationId?: string; limit?: number; offset?: number };
    result: { runs: AutomationRun[]; total: number };
  };
  "automation.delete": { params: { automationId: string }; result: { ok: true } };

  // ── plugins ─────────────────────────────────────────────────────────────
  "plugin.list": { params: Record<string, never>; result: { plugins: InstalledPlugin[] } };
  "plugin.install": {
    params: { path: string; trust?: string };
    result: { plugin: InstalledPlugin };
  };
  "plugin.setEnabled": { params: { pluginId: string; enabled: boolean }; result: { ok: true } };
  "plugin.uninstall": { params: { pluginId: string }; result: { ok: true } };

  // ── settings ────────────────────────────────────────────────────────────
  "settings.get": {
    params: { scope?: string; scopeId?: string };
    result: { settings: Record<string, unknown> };
  };
  "settings.set": {
    params: { key: string; value: unknown; scope?: string; scopeId?: string };
    result: { ok: true };
  };

  // ── channels / nodes (OpenClaw adapter) ─────────────────────────────────
  "channel.list": { params: Record<string, never>; result: { channels: ChannelInfo[] } };
  "channel.pair": {
    params: { channelKind: string; pairingCode?: string };
    result: { ok: boolean; instructions?: string };
  };
  "node.list": { params: Record<string, never>; result: { nodes: NodeInfo[] } };

  // ── data management ─────────────────────────────────────────────────────
  "data.exportAll": { params: { targetDir: string }; result: { artifact: Artifact } };
  "data.deleteAll": { params: { confirm: true }; result: { ok: true } };
}

export type CommandName = keyof CommandMap;
export type CommandParams<N extends CommandName> = CommandMap[N]["params"];
export type CommandResult<N extends CommandName> = CommandMap[N]["result"];

// ── supporting result types ────────────────────────────────────────────────

export interface ToolDescriptor {
  name: string;
  description: string;
  parametersSchema: Record<string, unknown>;
  capabilities: string[];
  source: "core" | "plugin" | "mcp" | "skill";
}

export interface WorkspaceStatus {
  isGit: boolean;
  branch?: string;
  dirty: boolean;
  dirtyFiles: string[];
  ahead?: number;
  behind?: number;
}

export interface DiffHunk {
  index: number;
  header: string;
  lines: string[];
  accepted: boolean | null; // null = undecided
}

export interface DiffFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
}

export interface DiffResult {
  files: DiffFile[];
  truncated: boolean;
}

export interface UsageBucket {
  key: string;
  usage: TokenUsage;
  requests: number;
}

export interface DiagnosticsReport {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
  platform: { os: string; arch: string; node: string };
  dataDir: string;
  dbSizeBytes: number;
  eventLogSize: number;
}

export interface ChannelInfo {
  id: string;
  kind: string;
  connected: boolean;
  allowlistedIdentities: string[];
}

export interface NodeInfo {
  id: string;
  name: string;
  platform: string;
  connected: boolean;
  capabilities: string[];
}

// re-export for convenience of implementors
export type {
  Agent,
  AgentRun,
  AgentTask,
  ApprovalDecision,
  ApprovalRequest,
  Artifact,
  Automation,
  AutomationRun,
  Checkpoint,
  InstalledPlugin,
  MemoryEntry,
  MemorySearchResult,
  Message,
  ModelDefinition,
  Profile,
  Project,
  ProviderConfig,
  Session,
  SkillDefinition,
  SkillProposal,
  Workspace,
  Worktree,
} from "./commands-types.js";
