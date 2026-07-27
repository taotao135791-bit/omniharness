import type {
  ApprovalDecision,
  ApprovalRequest,
  Checkpoint,
  DomainEvent,
  Message,
  Session,
  Workspace,
} from "@omniharness/agent-protocol";
import type { SessionId } from "@omniharness/shared-types";
import type { OmniClient } from "@omniharness/client-sdk";
import { getPath } from "@omniharness/config-schema";
import type { ModelRole } from "@omniharness/shared-types";
import type { CommandSpec } from "@omniharness/ui-command-registry";
import { ApprovalsViewModel } from "../vm/approvals-vm.js";
import { AutomationsViewModel } from "../vm/automations-vm.js";
import { ChatViewModel } from "../vm/chat-vm.js";
import { DiffViewModel } from "../vm/diff-vm.js";
import { DiagnosticLog, LogsViewModel } from "../vm/logs-vm.js";
import { MemoryViewModel } from "../vm/memory-vm.js";
import { ModelsViewModel } from "../vm/models-vm.js";
import { SessionsViewModel, SESSION_PAGE_SIZE } from "../vm/sessions-vm.js";
import { SettingsViewModel } from "../vm/settings-vm.js";
import { SkillsViewModel } from "../vm/skills-vm.js";
import { APPROVAL_SCOPE_RPC, type ApprovalScope, type ConnectionState, type ViewName } from "./types.js";
import { executeSlashCommand } from "./slash-commands.js";

export interface ControllerCallbacks {
  /** Called whenever any state changed — the shell schedules a re-render. */
  onChange(): void;
  /** Async RPC failure surfaced to the user (chat system line / status flash). */
  onError(message: string): void;
}

const EMPTY_SETTINGS: Record<string, unknown> = {};

/**
 * The wiring hub: owns the OmniClient, all view-models, and every action.
 * Views render view-models and call controller actions; the controller is
 * fully testable against a FakeDaemon without any terminal.
 */
export class AppController {
  view: ViewName = "sessions";
  connection: ConnectionState = "disconnected";
  daemonVersion: string | null = null;
  currentSession: Session | null = null;
  primaryModelId: string | null = null;
  /** First pending approval awaiting the user (rest stay in the queue). */
  pendingApproval: ApprovalRequest | null = null;
  statusFlash: string | null = null;

  readonly chat = new ChatViewModel();
  readonly sessions = new SessionsViewModel();
  readonly diff = new DiffViewModel();
  readonly models = new ModelsViewModel();
  readonly approvals = new ApprovalsViewModel();
  readonly memory = new MemoryViewModel();
  readonly skills = new SkillsViewModel();
  readonly automations = new AutomationsViewModel();
  readonly logs = new LogsViewModel();
  readonly settings = new SettingsViewModel();
  readonly diagLog = new DiagnosticLog();

  showTokenUsage = true;

  private readonly loaded = new Set<ViewName>();

  constructor(
    private readonly client: OmniClient,
    private readonly cb: ControllerCallbacks,
  ) {}

  /** Wire the client event stream. Call once after connect. */
  attach(): void {
    this.client.onEvent((ev) => this.handleEvent(ev));
    this.client.onConnectionChange((state) => {
      this.connection = state;
      this.cb.onChange();
    });
    this.daemonVersion = this.client.daemonVersion;
  }

  /** Initial loads after connect. */
  async init(): Promise<void> {
    await Promise.all([
      this.refreshSessions(0),
      this.loadSettings(),
      this.refreshApprovals(),
      this.refreshPrimaryModel(),
    ]);
  }

  flash(message: string): void {
    this.statusFlash = message;
    this.cb.onChange();
  }

  private reportError(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.cb.onError(message);
    this.cb.onChange();
  }

  // ── event stream ────────────────────────────────────────────────────────

  handleEvent(ev: DomainEvent): void {
    switch (ev.type) {
      case "session.created":
      case "session.archived":
        void this.refreshSessions(this.sessions.offset).catch(() => undefined);
        break;
      case "session.updated":
        if (this.currentSession?.id === ev.sessionId) {
          this.currentSession = { ...this.currentSession, title: ev.title, tags: ev.tags };
          this.chat.sessionTitle = ev.title;
        }
        void this.refreshSessions(this.sessions.offset).catch(() => undefined);
        break;
      case "approval.requested":
        this.approvals.upsert(ev.approval);
        if (this.pendingApproval === null) this.pendingApproval = ev.approval;
        break;
      case "approval.resolved":
        this.approvals.removeResolved(ev.approvalId);
        this.chat.resolveApprovalBlock(ev.approvalId, ev.status);
        if (this.pendingApproval?.id === ev.approvalId) this.pendingApproval = null;
        break;
      case "diagnostic":
        this.diagLog.push({ at: ev.at, level: ev.level, message: ev.message });
        break;
      case "model.changed":
        if (ev.role === "primary") this.primaryModelId = ev.modelId;
        break;
      case "memory.proposed":
        if (this.loaded.has("memory")) void this.loadMemory().catch(() => undefined);
        break;
      case "skill.proposed":
        if (this.loaded.has("skills")) void this.loadSkills().catch(() => undefined);
        break;
      case "automation.updated":
        this.automations.upsert(ev.automation);
        break;
      default:
        break;
    }
    // message.*, tool.*, run.* all flow into the chat transcript.
    this.chat.applyEvent(ev);
    this.cb.onChange();
  }

  // ── view routing ────────────────────────────────────────────────────────

  async setView(view: ViewName): Promise<void> {
    this.view = view;
    this.cb.onChange();
    if (this.loaded.has(view)) return;
    this.loaded.add(view);
    try {
      switch (view) {
        case "sessions":
          await this.refreshSessions(0);
          break;
        case "diff":
          await this.loadDiff();
          break;
        case "models":
          await this.loadModels();
          break;
        case "approvals":
          await this.refreshApprovals();
          break;
        case "memory":
          await this.loadMemory();
          break;
        case "skills":
          await this.loadSkills();
          break;
        case "automations":
          await this.loadAutomations();
          break;
        case "logs":
          await this.loadDiagnostics();
          break;
        case "settings":
          await this.loadSettings();
          break;
        case "chat":
          break;
      }
    } catch (err) {
      this.reportError(err);
    }
  }

  /** Reload the active view's data (pull-to-refresh). */
  async reloadCurrentView(): Promise<void> {
    const v = this.view;
    this.loaded.delete(v);
    await this.setView(v);
  }

  // ── sessions ────────────────────────────────────────────────────────────

  async refreshSessions(offset: number): Promise<void> {
    this.sessions.loading = true;
    this.cb.onChange();
    try {
      const res = await this.client.call("session.list", {
        limit: SESSION_PAGE_SIZE,
        offset,
      });
      this.sessions.setPage(res.sessions, res.total, offset);
    } catch (err) {
      this.sessions.setError(err instanceof Error ? err.message : String(err));
    }
    this.cb.onChange();
  }

  async nextSessionPage(): Promise<void> {
    if (!this.sessions.hasMore) return;
    await this.refreshSessions(this.sessions.offset + SESSION_PAGE_SIZE);
  }

  async prevSessionPage(): Promise<void> {
    if (this.sessions.offset <= 0) return;
    await this.refreshSessions(Math.max(0, this.sessions.offset - SESSION_PAGE_SIZE));
  }

  async listWorkspaces(): Promise<Workspace[]> {
    const res = await this.client.call("workspace.list", {});
    return res.workspaces;
  }

  async createSession(workspaceId: string, title?: string): Promise<Session> {
    const res = await this.client.call("session.create", {
      workspaceId,
      ...(title !== undefined ? { title } : {}),
    });
    await this.refreshSessions(0);
    return res.session;
  }

  async openSession(sessionId: SessionId): Promise<void> {
    const [getRes, msgRes] = await Promise.all([
      this.client.call("session.get", { sessionId }),
      this.client.call("session.messages", { sessionId, limit: 200 }),
    ]);
    this.currentSession = getRes.session;
    this.chat.reset(sessionId, getRes.session.title);
    this.chat.loadHistory(msgRes.messages);
    await this.refreshPrimaryModel();
    await this.setView("chat");
  }

  async renameSession(sessionId: SessionId, title: string): Promise<void> {
    const res = await this.client.call("session.rename", { sessionId, title });
    if (this.currentSession?.id === sessionId) {
      this.currentSession = res.session;
      this.chat.sessionTitle = res.session.title;
    }
    await this.refreshSessions(this.sessions.offset);
  }

  async archiveSession(sessionId: SessionId): Promise<void> {
    await this.client.call("session.archive", { sessionId });
    if (this.currentSession?.id === sessionId) this.currentSession = null;
    await this.refreshSessions(this.sessions.offset);
  }

  async setSessionTags(sessionId: SessionId, tags: string[]): Promise<void> {
    const res = await this.client.call("session.setTags", { sessionId, tags });
    if (this.currentSession?.id === sessionId) this.currentSession = res.session;
    await this.refreshSessions(this.sessions.offset);
  }

  async branchFromMessage(fromMessageId: string): Promise<void> {
    if (!this.currentSession) return;
    const res = await this.client.call("session.branch", {
      sessionId: this.currentSession.id,
      fromMessageId,
    });
    await this.openSession(res.session.id);
  }

  /** Recent messages of the current session (for the branch picker). */
  async listCurrentMessages(): Promise<Message[]> {
    if (!this.currentSession) return [];
    const res = await this.client.call("session.messages", {
      sessionId: this.currentSession.id,
      limit: 100,
    });
    return res.messages;
  }

  /** Export the current session; returns the artifact URI. */
  async exportCurrentSession(format: "json" | "markdown"): Promise<string | null> {
    if (!this.currentSession) return null;
    const res = await this.client.call("session.export", {
      sessionId: this.currentSession.id,
      format,
    });
    return res.artifact.uri;
  }

  // ── chat / runs ─────────────────────────────────────────────────────────

  /** Main chat submit: slash command, steer while running, else run.start. */
  async submitChat(raw: string): Promise<void> {
    const text = raw.trim();
    if (!text) return;
    if (text.startsWith("/")) {
      const handled = await executeSlashCommand(this, text);
      if (!handled) this.chat.addSystemMessage(`unknown command: ${text} (try /help)`);
      this.cb.onChange();
      return;
    }
    if (!this.currentSession) {
      this.chat.addSystemMessage("no session open — pick one from the sessions view (ctrl+1)");
      this.cb.onChange();
      return;
    }
    if (this.chat.activeRun) {
      await this.steer(text);
      return;
    }
    this.chat.addUserMessage(text);
    this.cb.onChange();
    try {
      await this.client.call("run.start", { sessionId: this.currentSession.id, input: text });
    } catch (err) {
      this.reportError(err);
    }
  }

  async steer(text: string): Promise<void> {
    const run = this.chat.activeRun;
    if (!run) return;
    this.chat.addSystemMessage(`steer: ${text}`);
    this.cb.onChange();
    try {
      await this.client.call("run.steer", { runId: run.runId, input: text });
    } catch (err) {
      this.reportError(err);
    }
  }

  async enqueueFollowUp(text: string): Promise<void> {
    if (!this.currentSession) return;
    try {
      const res = await this.client.call("run.enqueueFollowUp", {
        sessionId: this.currentSession.id,
        input: text,
      });
      this.chat.queuedFollowUps = Math.max(this.chat.queuedFollowUps, res.queuePosition);
      this.chat.addSystemMessage(`queued follow-up (#${res.queuePosition}): ${text}`);
    } catch (err) {
      this.reportError(err);
    }
    this.cb.onChange();
  }

  async interrupt(): Promise<void> {
    const run = this.chat.activeRun;
    if (!run) {
      this.flash("no active run");
      return;
    }
    try {
      await this.client.call("run.interrupt", { runId: run.runId });
      this.chat.addSystemMessage("interrupt requested");
    } catch (err) {
      this.reportError(err);
    }
    this.cb.onChange();
  }

  async createCheckpoint(label?: string): Promise<void> {
    if (!this.currentSession) {
      this.chat.addSystemMessage("no session open");
      this.cb.onChange();
      return;
    }
    try {
      const res = await this.client.call("checkpoint.create", {
        sessionId: this.currentSession.id,
        ...(label !== undefined ? { label } : {}),
      });
      this.chat.addSystemMessage(`checkpoint created: ${res.checkpoint.label} (${res.checkpoint.id})`);
    } catch (err) {
      this.reportError(err);
    }
    this.cb.onChange();
  }

  async listCheckpoints(): Promise<Checkpoint[]> {
    if (!this.currentSession) return [];
    const res = await this.client.call("checkpoint.list", { sessionId: this.currentSession.id });
    return res.checkpoints;
  }

  async restoreCheckpoint(checkpointId: string): Promise<void> {
    try {
      await this.client.call("checkpoint.restore", { checkpointId });
      this.chat.addSystemMessage(`checkpoint restored: ${checkpointId}`);
    } catch (err) {
      this.reportError(err);
    }
    this.cb.onChange();
  }

  // ── approvals ───────────────────────────────────────────────────────────

  async refreshApprovals(): Promise<void> {
    this.approvals.loading = true;
    this.cb.onChange();
    try {
      const res = await this.client.call("approval.list", { status: "pending", limit: 100 });
      this.approvals.setApprovals(res.approvals);
      if (this.pendingApproval === null && res.approvals.length > 0) {
        this.pendingApproval = res.approvals[0] ?? null;
      }
    } catch (err) {
      this.approvals.setError(err instanceof Error ? err.message : String(err));
    }
    this.cb.onChange();
  }

  async resolveApproval(
    approvalId: string,
    decision: ApprovalDecision,
    scope: ApprovalScope,
  ): Promise<void> {
    try {
      await this.client.call("approval.resolve", {
        approvalId,
        decision,
        ...(decision === "approve" && scope !== "once"
          ? { rememberScope: APPROVAL_SCOPE_RPC[scope] }
          : {}),
      });
      // The approval.resolved event updates local state; reflect immediately
      // too in case the daemon doesn't echo to the resolving client.
      this.approvals.removeResolved(approvalId);
      this.chat.resolveApprovalBlock(approvalId, decision === "approve" ? "approved" : "denied");
      if (this.pendingApproval?.id === approvalId) {
        this.pendingApproval = this.approvals.approvals[0] ?? null;
      }
    } catch (err) {
      this.reportError(err);
    }
    this.cb.onChange();
  }

  // ── models ──────────────────────────────────────────────────────────────

  async refreshPrimaryModel(): Promise<void> {
    try {
      const res = await this.client.call("model.getRoleBindings", {
        ...(this.currentSession ? { sessionId: this.currentSession.id } : {}),
      });
      this.primaryModelId = res.bindings.primary ?? null;
    } catch {
      // bindings are best-effort chrome; ignore
    }
  }

  async loadModels(): Promise<void> {
    this.models.loading = true;
    this.cb.onChange();
    try {
      const [providers, models, bindings] = await Promise.all([
        this.client.call("provider.list", {}),
        this.client.call("model.list", {}),
        this.client.call("model.getRoleBindings", {
          ...(this.currentSession ? { sessionId: this.currentSession.id } : {}),
        }),
      ]);
      this.models.setData(providers.providers, models.models, bindings.bindings);
      this.primaryModelId = bindings.bindings.primary ?? null;
    } catch (err) {
      this.models.setError(err instanceof Error ? err.message : String(err));
    }
    this.cb.onChange();
  }

  async setRoleBinding(role: ModelRole, modelId: string | null): Promise<void> {
    try {
      await this.client.call("model.setRoleBinding", {
        role,
        modelId,
        scope: this.currentSession ? "session" : "profile",
        ...(this.currentSession ? { sessionId: this.currentSession.id } : {}),
      });
      if (role === "primary") this.primaryModelId = modelId;
      this.flash(modelId ? `${role} → ${this.models.modelDisplayName(modelId)}` : `${role} binding cleared`);
      if (this.loaded.has("models")) await this.loadModels();
    } catch (err) {
      this.reportError(err);
    }
    this.cb.onChange();
  }

  async testProvider(providerId: string): Promise<void> {
    this.models.statusLine = `testing provider…`;
    this.cb.onChange();
    try {
      const res = await this.client.call("provider.test", { providerId });
      this.models.statusLine = res.ok
        ? `provider OK (${res.latencyMs}ms)${res.models ? ` — ${res.models.length} models` : ""}`
        : `provider FAILED: ${res.error ?? "unknown error"}`;
    } catch (err) {
      this.models.statusLine = `provider test error: ${err instanceof Error ? err.message : String(err)}`;
    }
    this.cb.onChange();
  }

  // ── diff ────────────────────────────────────────────────────────────────

  async loadDiff(): Promise<void> {
    this.diff.loading = true;
    this.cb.onChange();
    try {
      const params = this.currentSession
        ? { sessionId: this.currentSession.id }
        : this.sessions.sessions[0]
          ? { workspaceId: this.sessions.sessions[0].workspaceId }
          : {};
      const res = await this.client.call("diff.get", params);
      this.diff.setDiff(res);
    } catch (err) {
      this.diff.setError(err instanceof Error ? err.message : String(err));
    }
    this.cb.onChange();
  }

  async diffResolve(
    action: "accept" | "reject",
    target: { file?: string; hunkIndex?: number } | "all",
  ): Promise<void> {
    const base = this.currentSession ? { sessionId: this.currentSession.id } : {};
    const params = target === "all" ? base : { ...base, ...target };
    try {
      if (action === "accept") await this.client.call("diff.accept", params);
      else await this.client.call("diff.reject", params);
      if (target === "all") {
        for (const f of this.diff.files) {
          this.diff.markResolved({ file: f.path }, action === "accept");
        }
      } else {
        this.diff.markResolved(target, action === "accept");
      }
    } catch (err) {
      this.reportError(err);
    }
    this.cb.onChange();
  }

  // ── memory / skills / automations ───────────────────────────────────────

  async loadMemory(search?: string): Promise<void> {
    this.memory.loading = true;
    this.cb.onChange();
    try {
      if (search) {
        this.memory.searchText = search;
        const res = await this.client.call("memory.search", {
          text: search,
          limit: 100,
          includePending: true,
        });
        this.memory.setMemories(
          res.results.map((r) => r.entry),
          res.results.length,
        );
      } else {
        const res = await this.client.call("memory.list", { limit: 200 });
        this.memory.setMemories(res.memories, res.total);
      }
    } catch (err) {
      this.memory.setError(err instanceof Error ? err.message : String(err));
    }
    this.cb.onChange();
  }

  async memoryAction(action: "approve" | "reject" | "delete", memoryId: string): Promise<void> {
    try {
      if (action === "approve") await this.client.call("memory.approve", { memoryId });
      else if (action === "reject") await this.client.call("memory.reject", { memoryId });
      else await this.client.call("memory.delete", { memoryId });
      await this.loadMemory(this.memory.searchText || undefined);
    } catch (err) {
      this.reportError(err);
    }
    this.cb.onChange();
  }

  async loadSkills(): Promise<void> {
    this.skills.loading = true;
    this.cb.onChange();
    try {
      const [skills, proposals] = await Promise.all([
        this.client.call("skill.list", {}),
        this.client.call("skill.proposals", { status: "pending" }),
      ]);
      this.skills.setData(skills.skills, proposals.proposals);
    } catch (err) {
      this.skills.setError(err instanceof Error ? err.message : String(err));
    }
    this.cb.onChange();
  }

  async toggleSkill(skillId: string, enabled: boolean): Promise<void> {
    try {
      await this.client.call("skill.setEnabled", { skillId, enabled });
      await this.loadSkills();
    } catch (err) {
      this.reportError(err);
    }
  }

  async resolveSkillProposal(proposalId: string, approve: boolean): Promise<void> {
    try {
      if (approve) await this.client.call("skill.approveProposal", { proposalId });
      else await this.client.call("skill.rejectProposal", { proposalId });
      await this.loadSkills();
    } catch (err) {
      this.reportError(err);
    }
  }

  async loadAutomations(): Promise<void> {
    this.automations.loading = true;
    this.cb.onChange();
    try {
      const [list, runs] = await Promise.all([
        this.client.call("automation.list", {}),
        this.client.call("automation.runs", { limit: 50 }),
      ]);
      // Keep only the most recent run per automation for the last-run column.
      const latest = new Map<string, (typeof runs.runs)[number]>();
      for (const r of runs.runs) {
        if (!latest.has(r.automationId)) latest.set(r.automationId, r);
      }
      this.automations.setData(list.automations, [...latest.values()]);
    } catch (err) {
      this.automations.setError(err instanceof Error ? err.message : String(err));
    }
    this.cb.onChange();
  }

  async toggleAutomation(automationId: string, enabled: boolean): Promise<void> {
    try {
      await this.client.call("automation.setEnabled", { automationId, enabled });
      await this.loadAutomations();
    } catch (err) {
      this.reportError(err);
    }
  }

  async runAutomationNow(automationId: string): Promise<void> {
    try {
      await this.client.call("automation.runNow", { automationId });
      this.flash("automation started");
    } catch (err) {
      this.reportError(err);
    }
    this.cb.onChange();
  }

  // ── logs / settings / usage ─────────────────────────────────────────────

  async loadDiagnostics(): Promise<void> {
    this.logs.loading = true;
    this.cb.onChange();
    try {
      const res = await this.client.call("system.diagnostics", {});
      this.logs.setReport(res);
    } catch (err) {
      this.logs.setError(err instanceof Error ? err.message : String(err));
    }
    this.cb.onChange();
  }

  async loadSettings(): Promise<void> {
    this.settings.loading = true;
    this.cb.onChange();
    try {
      const res = await this.client.call("settings.get", {});
      this.settings.setSettings(res.settings);
      this.applyLocalSettings(res.settings);
    } catch (err) {
      this.settings.setError(err instanceof Error ? err.message : String(err));
    }
    this.cb.onChange();
  }

  private applyLocalSettings(settings: Record<string, unknown>): void {
    const collapse = getPath(settings, "tui.collapseToolCalls");
    if (typeof collapse === "boolean") this.chat.collapseToolCalls = collapse;
    const showUsage = getPath(settings, "tui.showTokenUsage");
    if (typeof showUsage === "boolean") this.showTokenUsage = showUsage;
  }

  async saveSetting(key: string, value: unknown): Promise<void> {
    try {
      await this.client.call("settings.set", { key, value });
      this.settings.setValue(key, value);
      this.settings.statusLine = `saved ${key}`;
      this.applyLocalSettings({ ...EMPTY_SETTINGS, ...settingsObjectFor(key, value) });
    } catch (err) {
      this.settings.statusLine = `error: ${err instanceof Error ? err.message : String(err)}`;
    }
    this.cb.onChange();
  }

  async usageSummaryText(): Promise<string> {
    try {
      const res = await this.client.call("usage.summary", { groupBy: "model" });
      if (res.usage.length === 0) return "no usage recorded yet";
      return res.usage
        .map(
          (b) =>
            `${b.key}: ↑${b.usage.inputTokens} ↓${b.usage.outputTokens} $${(b.usage.costUsd ?? 0).toFixed(4)} (${b.requests} req)`,
        )
        .join("\n");
    } catch (err) {
      return `usage error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  compactionStatusText(): string {
    const u = this.chat.usage;
    const lastCompaction = [...this.chat.blocks].reverse().find((b) => b.kind === "compaction");
    const lines = [
      `session tokens: ↑${u.inputTokens} ↓${u.outputTokens} cost $${u.costUsd.toFixed(4)} across ${u.runs} runs`,
    ];
    if (lastCompaction && lastCompaction.kind === "compaction") {
      lines.push(
        lastCompaction.done
          ? `last compaction: ${lastCompaction.beforeTokens ?? "?"} → ${lastCompaction.afterTokens ?? "?"} tokens`
          : `compaction in progress (${lastCompaction.beforeTokens ?? "?"} tokens)`,
      );
    } else {
      lines.push("no compaction yet this session");
    }
    if (this.chat.activeRun?.compacting) lines.push("currently compacting…");
    return lines.join("\n");
  }

  // ── palette commands ────────────────────────────────────────────────────

  /**
   * Execute a palette command that needs no extra input. Interactive
   * commands (needing a title/workspace/model choice) are handled by the
   * shell, which opens the matching picker.
   */
  async executeCommand(spec: CommandSpec): Promise<void> {
    switch (spec.id) {
      case "view.sessions":
        return this.setView("sessions");
      case "view.diff":
        return this.setView("diff");
      case "view.models":
        return this.setView("models");
      case "view.logs":
        return this.setView("logs");
      case "view.settings":
        return this.setView("settings");
      case "session.archive": {
        const s = this.currentSession ?? this.sessions.selectedSession();
        if (s) await this.archiveSession(s.id);
        return;
      }
      case "agent.interrupt":
        return this.interrupt();
      case "diff.review":
        return this.setView("diff");
      case "diff.acceptAll":
        return this.diffResolve("accept", "all");
      case "diff.rejectAll":
        return this.diffResolve("reject", "all");
      case "checkpoint.create":
        return this.createCheckpoint();
      case "approval.review":
        return this.setView("approvals");
      case "memory.review":
        return this.setView("memory");
      case "skill.browse":
        return this.setView("skills");
      case "skill.proposals":
        return this.setView("skills");
      case "automation.runNow": {
        const a = this.automations.selected();
        if (a) await this.runAutomationNow(a.id);
        return;
      }
      case "model.bindings":
        return this.setView("models");
      case "system.diagnostics":
        return this.setView("logs");
      case "system.usage": {
        const text = await this.usageSummaryText();
        this.chat.addSystemMessage(text);
        this.cb.onChange();
        return;
      }
      case "system.shutdown":
        try {
          await this.client.call("system.shutdown", { reason: "tui request" });
          this.flash("daemon shutting down");
        } catch (err) {
          this.reportError(err);
        }
        return;
      default:
        this.flash(`"${spec.title}" needs a picker — use the matching view`);
        return;
    }
  }
}

/** Build a nested settings object for one dot-path key (for local application). */
function settingsObjectFor(key: string, value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const parts = key.split(".");
  let cur = out;
  for (let i = 0; i < parts.length - 1; i++) {
    const next: Record<string, unknown> = {};
    cur[parts[i]!] = next;
    cur = next;
  }
  cur[parts[parts.length - 1]!] = value;
  return out;
}
