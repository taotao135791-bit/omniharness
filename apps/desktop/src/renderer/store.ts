import type {
  Agent,
  AgentRun,
  ApprovalDecision,
  ApprovalRequest,
  Artifact,
  Checkpoint,
  DiagnosticsReport,
  DiffResult,
  Profile,
  Project,
  Session,
  Workspace,
} from "@omniharness/agent-protocol";
import type { DomainEvent, OmniBridge } from "./bridge.js";
import { normalizeDaemonState, type DaemonState } from "./bridge.js";
import {
  appendUserMessage,
  chatStateFromHistory,
  emptyChatState,
  reduceChatEvent,
  type ChatState,
} from "./vm/chat.js";

export type MainView =
  | "chat"
  | "models"
  | "memory"
  | "skills"
  | "automations"
  | "plugins"
  | "settings"
  | "diagnostics";

export type InspectorTab = "diff" | "files" | "artifacts" | "context" | "usage";
export type BottomTab = "logs" | "approvals" | "problems";

export interface LogLine {
  id: number;
  at: string;
  level: "info" | "warn" | "error";
  text: string;
}

export interface DirtyFiles {
  branch: string | null;
  files: string[];
}

export interface AppState {
  daemon: DaemonState;
  version: string | null;
  view: MainView;
  inspectorTab: InspectorTab;
  bottomTab: BottomTab;
  bottomOpen: boolean;
  paletteOpen: boolean;
  theme: "dark" | "light";
  profiles: Profile[];
  activeProfileId: string | null;
  projects: Project[];
  activeProjectId: string | null;
  workspaces: Workspace[];
  sessions: Session[];
  activeSessionId: string | null;
  agents: Agent[];
  runs: AgentRun[];
  chat: ChatState;
  approvals: ApprovalRequest[];
  logs: LogLine[];
  diagnostics: DiagnosticsReport | null;
  diff: DiffResult | null;
  checkpoints: Checkpoint[];
  artifacts: Artifact[];
  dirtyFiles: DirtyFiles | null;
  settings: Record<string, unknown>;
  /** Bumped whenever page-domain data may be stale; pages refetch on change. */
  dataRevision: number;
}

function initialState(): AppState {
  return {
    daemon: "starting",
    version: null,
    view: "chat",
    inspectorTab: "diff",
    bottomTab: "logs",
    bottomOpen: true,
    paletteOpen: false,
    theme: "dark",
    profiles: [],
    activeProfileId: null,
    projects: [],
    activeProjectId: null,
    workspaces: [],
    sessions: [],
    activeSessionId: null,
    agents: [],
    runs: [],
    chat: emptyChatState(),
    approvals: [],
    logs: [],
    diagnostics: null,
    diff: null,
    checkpoints: [],
    artifacts: [],
    dirtyFiles: null,
    settings: {},
    dataRevision: 0,
  };
}

const MAX_LOG_LINES = 500;

/**
 * Central renderer store. Owns the daemon bridge subscriptions and all
 * cross-view state; view-models stay pure, components stay thin.
 */
export class AppStore {
  private state: AppState = initialState();
  private listeners = new Set<() => void>();
  private eventListeners = new Set<(e: DomainEvent) => void>();
  private chatBySession = new Map<string, ChatState>();
  private logSeq = 0;
  private localSeq = 0;

  constructor(private readonly bridge: OmniBridge) {}

  get snapshot(): AppState {
    return this.state;
  }

  get rpc(): OmniBridge {
    return this.bridge;
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  /** Raw domain-event subscription for page-level refetching. */
  subscribeEvents = (fn: (e: DomainEvent) => void): (() => void) => {
    this.eventListeners.add(fn);
    return () => this.eventListeners.delete(fn);
  };

  private set(patch: Partial<AppState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  private bumpData(): void {
    this.set({ dataRevision: this.state.dataRevision + 1 });
  }

  private log(level: LogLine["level"], text: string): void {
    const line: LogLine = {
      id: ++this.logSeq,
      at: new Date().toISOString(),
      level,
      text,
    };
    const logs = [...this.state.logs, line];
    this.set({ logs: logs.length > MAX_LOG_LINES ? logs.slice(-MAX_LOG_LINES) : logs });
  }

  /** Wire bridge subscriptions; call once at startup. */
  start(): () => void {
    const offState = this.bridge.onState((raw) => {
      const daemon = normalizeDaemonState(raw);
      this.set({ daemon });
      if (daemon === "connected") void this.bootstrap();
      if (daemon === "disconnected") this.log("warn", "daemon disconnected — waiting to reconnect");
    });
    const offEvents = this.bridge.onEvent((e) => this.handleEvent(e));
    return () => {
      offState();
      offEvents();
    };
  }

  private handleEvent(e: DomainEvent): void {
    for (const fn of this.eventListeners) fn(e);
    switch (e.type) {
      case "session.created":
      case "session.updated":
      case "session.archived":
        void this.refreshSessions();
        return;
      case "approval.requested":
        this.set({ approvals: [...this.state.approvals.filter((a) => a.id !== e.approval.id), e.approval] });
        return;
      case "approval.resolved":
        this.set({ approvals: this.state.approvals.filter((a) => a.id !== e.approvalId) });
        return;
      case "diagnostic":
        this.log(e.level, e.message);
        return;
      case "automation.fired":
      case "automation.run.completed":
      case "automation.run.failed":
      case "automation.updated":
      case "memory.proposed":
      case "memory.approved":
      case "memory.rejected":
      case "skill.proposed":
      case "skill.approved":
      case "skill.rejected":
      case "model.changed":
      case "provider.health":
        this.bumpData();
        return;
      case "tool.call.output":
        this.log("info", `[tool ${e.stream}] ${e.chunk.trimEnd()}`);
        break;
      case "run.failed":
        this.log("error", `run failed: ${e.error}`);
        break;
      default:
        break;
    }
    // Chat-related events: route into the per-session chat reducer.
    if ("sessionId" in e) {
      const sessionId = e.sessionId;
      const prev = this.chatBySession.get(sessionId) ?? emptyChatState();
      const next = reduceChatEvent(prev, sessionId, e);
      this.chatBySession.set(sessionId, next);
      const patch: Partial<AppState> = {};
      if (sessionId === this.state.activeSessionId) patch.chat = next;
      if (e.type === "run.completed" || e.type === "run.failed") {
        if (sessionId === this.state.activeSessionId) void this.refreshRuns();
        void this.refreshSessions();
      }
      if (Object.keys(patch).length > 0) this.set(patch);
    }
  }

  /** Full refresh after (re)connect. */
  async bootstrap(): Promise<void> {
    try {
      const ping = await this.bridge.call("system.ping", {});
      this.set({ version: ping.version });
      const [profiles, approvals, settings, diagnostics] = await Promise.all([
        this.bridge.call("profile.list", {}),
        this.bridge.call("approval.list", { status: "pending", limit: 50 }),
        this.bridge.call("settings.get", {}),
        this.bridge.call("system.diagnostics", {}),
      ]);
      const activeProfileId =
        this.state.activeProfileId ??
        profiles.profiles.find((p) => p.isDefault)?.id ??
        profiles.profiles[0]?.id ??
        null;
      this.set({
        profiles: profiles.profiles,
        activeProfileId,
        approvals: approvals.approvals,
        settings: settings.settings,
        diagnostics,
        theme: resolveTheme(settings.settings),
      });
      await this.refreshProjects();
      await this.refreshSessions();
    } catch (err) {
      this.log("error", `bootstrap failed: ${errMsg(err)}`);
    }
  }

  async refreshProjects(): Promise<void> {
    if (!this.state.activeProfileId) return;
    try {
      const r = await this.bridge.call("project.list", {
        profileId: this.state.activeProfileId,
      });
      const activeProjectId =
        this.state.activeProjectId && r.projects.some((p) => p.id === this.state.activeProjectId)
          ? this.state.activeProjectId
          : (r.projects[0]?.id ?? null);
      this.set({ projects: r.projects, activeProjectId });
      await this.refreshWorkspaces();
    } catch (err) {
      this.log("error", `project.list failed: ${errMsg(err)}`);
    }
  }

  async refreshWorkspaces(): Promise<void> {
    if (!this.state.activeProjectId) {
      this.set({ workspaces: [] });
      return;
    }
    try {
      const r = await this.bridge.call("workspace.list", {
        projectId: this.state.activeProjectId,
      });
      this.set({ workspaces: r.workspaces });
    } catch (err) {
      this.log("error", `workspace.list failed: ${errMsg(err)}`);
    }
  }

  async refreshSessions(): Promise<void> {
    try {
      const params: { limit: number; profileId?: string } = { limit: 200 };
      if (this.state.activeProfileId) params.profileId = this.state.activeProfileId;
      const r = await this.bridge.call("session.list", params);
      this.set({ sessions: r.sessions.filter((s) => s.status !== "archived") });
    } catch (err) {
      this.log("error", `session.list failed: ${errMsg(err)}`);
    }
  }

  async refreshRuns(): Promise<void> {
    const sessionId = this.state.activeSessionId;
    if (!sessionId) {
      this.set({ runs: [] });
      return;
    }
    try {
      const r = await this.bridge.call("run.list", { sessionId });
      this.set({ runs: r.runs });
    } catch (err) {
      this.log("error", `run.list failed: ${errMsg(err)}`);
    }
  }

  async refreshAgents(): Promise<void> {
    try {
      const params: { sessionId?: string } = {};
      if (this.state.activeSessionId) params.sessionId = this.state.activeSessionId;
      const r = await this.bridge.call("agent.list", params);
      this.set({ agents: r.agents });
    } catch (err) {
      this.log("error", `agent.list failed: ${errMsg(err)}`);
    }
  }

  // ── navigation ──────────────────────────────────────────────────────────

  setView(view: MainView): void {
    this.set({ view });
    if (view === "diagnostics") void this.refreshDiagnostics();
  }

  setInspectorTab(tab: InspectorTab): void {
    this.set({ inspectorTab: tab });
    if (tab === "diff") void this.refreshDiff();
    if (tab === "artifacts") void this.refreshArtifacts();
    if (tab === "files") void this.refreshDirtyFiles();
  }

  setBottomTab(tab: BottomTab): void {
    this.set({ bottomTab: tab, bottomOpen: true });
  }

  toggleBottom(): void {
    this.set({ bottomOpen: !this.state.bottomOpen });
  }

  setPaletteOpen(open: boolean): void {
    this.set({ paletteOpen: open });
  }

  // ── selection ───────────────────────────────────────────────────────────

  async selectProfile(profileId: string): Promise<void> {
    this.set({ activeProfileId: profileId, activeProjectId: null, activeSessionId: null });
    await this.refreshProjects();
    await this.refreshSessions();
  }

  async selectProject(projectId: string): Promise<void> {
    this.set({ activeProjectId: projectId });
    await this.refreshWorkspaces();
  }

  async selectSession(sessionId: string): Promise<void> {
    this.set({ activeSessionId: sessionId, view: "chat" });
    const cached = this.chatBySession.get(sessionId);
    if (cached) this.set({ chat: cached });
    try {
      const r = await this.bridge.call("session.messages", { sessionId, limit: 200 });
      const chat = chatStateFromHistory(r.messages);
      // Preserve live running state if a run is active for this session.
      const live = this.chatBySession.get(sessionId);
      if (live?.activeRunId) chat.activeRunId = live.activeRunId;
      this.chatBySession.set(sessionId, chat);
      if (this.state.activeSessionId === sessionId) this.set({ chat });
      await Promise.all([this.refreshRuns(), this.refreshAgents(), this.refreshCheckpoints()]);
    } catch (err) {
      this.log("error", `session.messages failed: ${errMsg(err)}`);
    }
  }

  // ── sessions / projects ─────────────────────────────────────────────────

  async createSession(): Promise<void> {
    const ws = this.state.workspaces[0];
    if (!ws) {
      this.log("warn", "no workspace in the active project — register one first");
      return;
    }
    try {
      const params: { workspaceId: string; profileId?: string } = { workspaceId: ws.id };
      if (this.state.activeProfileId) params.profileId = this.state.activeProfileId;
      const r = await this.bridge.call("session.create", params);
      await this.refreshSessions();
      await this.selectSession(r.session.id);
    } catch (err) {
      this.log("error", `session.create failed: ${errMsg(err)}`);
    }
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    try {
      await this.bridge.call("session.rename", { sessionId, title });
      await this.refreshSessions();
    } catch (err) {
      this.log("error", `session.rename failed: ${errMsg(err)}`);
    }
  }

  async archiveSession(sessionId: string): Promise<void> {
    try {
      await this.bridge.call("session.archive", { sessionId });
      if (this.state.activeSessionId === sessionId) {
        this.set({ activeSessionId: null, chat: emptyChatState(), runs: [] });
      }
      await this.refreshSessions();
    } catch (err) {
      this.log("error", `session.archive failed: ${errMsg(err)}`);
    }
  }

  async createProfile(name: string): Promise<void> {
    try {
      await this.bridge.call("profile.create", { name });
      const r = await this.bridge.call("profile.list", {});
      this.set({ profiles: r.profiles });
    } catch (err) {
      this.log("error", `profile.create failed: ${errMsg(err)}`);
    }
  }

  async createProject(name: string): Promise<void> {
    try {
      const params: { name: string; profileId?: string } = { name };
      if (this.state.activeProfileId) params.profileId = this.state.activeProfileId;
      await this.bridge.call("project.create", params);
      await this.refreshProjects();
    } catch (err) {
      this.log("error", `project.create failed: ${errMsg(err)}`);
    }
  }

  async registerWorkspace(path: string): Promise<void> {
    const projectId = this.state.activeProjectId;
    if (!projectId || !path.trim()) return;
    try {
      await this.bridge.call("workspace.register", {
        projectId,
        roots: [path.trim()],
      });
      await this.refreshWorkspaces();
    } catch (err) {
      this.log("error", `workspace.register failed: ${errMsg(err)}`);
    }
  }

  // ── chat / runs ─────────────────────────────────────────────────────────

  async send(input: string): Promise<void> {
    const sessionId = this.state.activeSessionId;
    if (!sessionId || !input.trim()) return;
    const localId = `local-${++this.localSeq}`;
    const chat = appendUserMessage(this.state.chat, localId, input.trim());
    this.chatBySession.set(sessionId, chat);
    this.set({ chat });
    try {
      const r = await this.bridge.call("run.start", { sessionId, input: input.trim() });
      const cur = this.chatBySession.get(sessionId) ?? chat;
      const next = { ...cur, activeRunId: r.runId };
      this.chatBySession.set(sessionId, next);
      if (this.state.activeSessionId === sessionId) this.set({ chat: next });
    } catch (err) {
      this.log("error", `run.start failed: ${errMsg(err)}`);
    }
  }

  async steer(input: string): Promise<void> {
    const runId = this.state.chat.activeRunId;
    if (!runId || !input.trim()) return;
    const sessionId = this.state.activeSessionId;
    if (sessionId) {
      const chat = appendUserMessage(this.state.chat, `local-${++this.localSeq}`, `(steer) ${input.trim()}`);
      this.chatBySession.set(sessionId, chat);
      this.set({ chat });
    }
    try {
      await this.bridge.call("run.steer", { runId, input: input.trim() });
    } catch (err) {
      this.log("error", `run.steer failed: ${errMsg(err)}`);
    }
  }

  async enqueueFollowUp(input: string): Promise<void> {
    const sessionId = this.state.activeSessionId;
    if (!sessionId || !input.trim()) return;
    try {
      const r = await this.bridge.call("run.enqueueFollowUp", {
        sessionId,
        input: input.trim(),
      });
      this.log("info", `follow-up queued at position ${r.queuePosition}`);
    } catch (err) {
      this.log("error", `run.enqueueFollowUp failed: ${errMsg(err)}`);
    }
  }

  async interrupt(): Promise<void> {
    const runId = this.state.chat.activeRunId;
    if (!runId) return;
    try {
      await this.bridge.call("run.interrupt", { runId });
    } catch (err) {
      this.log("error", `run.interrupt failed: ${errMsg(err)}`);
    }
  }

  async resolveApproval(
    approvalId: string,
    decision: ApprovalDecision,
    rememberScope?: string,
  ): Promise<void> {
    try {
      const params: { approvalId: string; decision: ApprovalDecision; rememberScope?: string } = {
        approvalId,
        decision,
      };
      if (rememberScope) params.rememberScope = rememberScope;
      await this.bridge.call("approval.resolve", params);
      this.set({ approvals: this.state.approvals.filter((a) => a.id !== approvalId) });
    } catch (err) {
      this.log("error", `approval.resolve failed: ${errMsg(err)}`);
    }
  }

  async setSessionModel(modelId: string): Promise<void> {
    const sessionId = this.state.activeSessionId;
    if (!sessionId) return;
    try {
      await this.bridge.call("model.setRoleBinding", {
        role: "primary",
        modelId,
        scope: "session",
        sessionId,
      });
      this.log("info", `session model set to ${modelId}`);
    } catch (err) {
      this.log("error", `model.setRoleBinding failed: ${errMsg(err)}`);
    }
  }

  // ── diff / checkpoints / artifacts / files ──────────────────────────────

  async refreshDiff(): Promise<void> {
    const sessionId = this.state.activeSessionId;
    if (!sessionId) {
      this.set({ diff: null });
      return;
    }
    try {
      const diff = await this.bridge.call("diff.get", { sessionId });
      this.set({ diff });
    } catch (err) {
      this.log("error", `diff.get failed: ${errMsg(err)}`);
    }
  }

  async diffDecision(
    kind: "accept" | "reject",
    file?: string,
    hunkIndex?: number,
  ): Promise<void> {
    const sessionId = this.state.activeSessionId;
    if (!sessionId) return;
    try {
      const params: { sessionId: string; file?: string; hunkIndex?: number } = { sessionId };
      if (file !== undefined) params.file = file;
      if (hunkIndex !== undefined) params.hunkIndex = hunkIndex;
      await this.bridge.call(kind === "accept" ? "diff.accept" : "diff.reject", params);
      await this.refreshDiff();
    } catch (err) {
      this.log("error", `diff.${kind} failed: ${errMsg(err)}`);
    }
  }

  async refreshCheckpoints(): Promise<void> {
    const sessionId = this.state.activeSessionId;
    if (!sessionId) {
      this.set({ checkpoints: [] });
      return;
    }
    try {
      const r = await this.bridge.call("checkpoint.list", { sessionId });
      this.set({ checkpoints: r.checkpoints });
    } catch (err) {
      this.log("error", `checkpoint.list failed: ${errMsg(err)}`);
    }
  }

  async createCheckpoint(label?: string): Promise<void> {
    const sessionId = this.state.activeSessionId;
    if (!sessionId) return;
    try {
      const params: { sessionId: string; label?: string } = { sessionId };
      if (label) params.label = label;
      await this.bridge.call("checkpoint.create", params);
      await this.refreshCheckpoints();
    } catch (err) {
      this.log("error", `checkpoint.create failed: ${errMsg(err)}`);
    }
  }

  async restoreCheckpoint(checkpointId: string): Promise<void> {
    try {
      await this.bridge.call("checkpoint.restore", { checkpointId });
      this.log("info", "checkpoint restored");
      await this.refreshDiff();
    } catch (err) {
      this.log("error", `checkpoint.restore failed: ${errMsg(err)}`);
    }
  }

  async refreshArtifacts(): Promise<void> {
    try {
      const params: { limit: number; sessionId?: string } = { limit: 100 };
      if (this.state.activeSessionId) params.sessionId = this.state.activeSessionId;
      const r = await this.bridge.call("artifact.list", params);
      this.set({ artifacts: r.artifacts });
    } catch (err) {
      this.log("error", `artifact.list failed: ${errMsg(err)}`);
    }
  }

  async refreshDirtyFiles(): Promise<void> {
    const ws = this.state.workspaces[0];
    if (!ws) {
      this.set({ dirtyFiles: null });
      return;
    }
    try {
      const r = await this.bridge.call("workspace.status", { workspaceId: ws.id });
      this.set({ dirtyFiles: { branch: r.branch ?? null, files: r.dirtyFiles } });
    } catch (err) {
      this.log("error", `workspace.status failed: ${errMsg(err)}`);
    }
  }

  // ── settings / theme / diagnostics ──────────────────────────────────────

  async saveSetting(key: string, value: unknown): Promise<boolean> {
    try {
      await this.bridge.call("settings.set", { key, value });
      const r = await this.bridge.call("settings.get", {});
      this.set({ settings: r.settings, theme: resolveTheme(r.settings) });
      return true;
    } catch (err) {
      this.log("error", `settings.set ${key} failed: ${errMsg(err)}`);
      return false;
    }
  }

  async setTheme(theme: "dark" | "light" | "system"): Promise<void> {
    await this.saveSetting("gui.theme", theme);
  }

  async refreshDiagnostics(): Promise<void> {
    try {
      const diagnostics = await this.bridge.call("system.diagnostics", {});
      this.set({ diagnostics });
    } catch (err) {
      this.log("error", `system.diagnostics failed: ${errMsg(err)}`);
    }
  }
}

function resolveTheme(settings: Record<string, unknown>): "dark" | "light" {
  const gui = settings["gui"];
  const raw =
    typeof gui === "object" && gui !== null
      ? (gui as Record<string, unknown>)["theme"]
      : undefined;
  const v = typeof raw === "string" ? raw : "system";
  if (v === "light") return "light";
  if (v === "dark") return "dark";
  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  return "dark";
}

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
