import {
  matchesKey,
  type Component,
  type Focusable,
  type OverlayHandle,
  type TUI,
} from "@earendil-works/pi-tui";
import type { CommandSpec } from "@omniharness/ui-command-registry";
import type { AppController } from "../core/app-controller.js";
import { VIEW_TITLES, type ViewName } from "../core/types.js";
import { bold, dim, fg } from "../theme.js";
import { truncate } from "../vm/layout.js";
import { renderHeader } from "./header.js";
import { renderStatusBar } from "./status-bar.js";
import { ChatView } from "../ui/chat-view.js";
import { InputOverlay, PaletteOverlay, SelectOverlay } from "../ui/overlays.js";
import type { ShellActions } from "../ui/shell-actions.js";
import {
  ApprovalsView,
  AutomationsView,
  DiffView,
  LogsView,
  MemoryView,
  ModelsView,
  SessionsView,
  SettingsView,
  SkillsView,
} from "../ui/views.js";

function fire(promise: Promise<unknown>): void {
  void promise.catch(() => undefined);
}

type FocusableComponent = Component & { focused?: boolean };

/**
 * Root component: header + routed view + status bar. Owns global keys and
 * the overlay pickers. All state lives in the controller/view-models.
 */
export class AppShell implements Component, Focusable {
  private _focused = true;
  private readonly views: Record<ViewName, FocusableComponent>;

  constructor(
    private readonly tui: TUI,
    private readonly controller: AppController,
    private readonly brand: string,
  ) {
    const actions: ShellActions = {
      openInput: (title, onSubmit, initial) => this.openInput(title, onSubmit, initial),
      openSelect: (title, items, onSelect) => this.openSelect(title, items, onSelect),
    };
    this.views = {
      sessions: new SessionsView(controller, actions),
      chat: new ChatView(tui, controller),
      diff: new DiffView(controller),
      models: new ModelsView(controller, actions),
      approvals: new ApprovalsView(controller),
      memory: new MemoryView(controller, actions),
      skills: new SkillsView(controller),
      automations: new AutomationsView(controller),
      logs: new LogsView(controller),
      settings: new SettingsView(controller, actions),
    };
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    const view = this.views[this.controller.view];
    if (view) view.focused = value;
  }

  invalidate(): void {
    for (const view of Object.values(this.views)) view.invalidate();
  }

  render(width: number): string[] {
    if (width < 40) {
      return [
        bold(fg.yellow("Terminal too narrow")),
        dim(`need at least 40 columns (have ${width})`),
        dim("resize to continue"),
      ];
    }
    const c = this.controller;
    const modelLabel = c.primaryModelId ? c.models.modelDisplayName(c.primaryModelId) : null;
    const header = renderHeader(
      {
        brand: this.brand,
        connection: c.connection,
        daemonVersion: c.daemonVersion,
        sessionTitle: c.chat.sessionTitle || null,
        modelLabel,
        usageLabel: c.showTokenUsage && c.view === "chat" ? c.chat.usageSummary() : null,
        pendingApprovals: c.approvals.approvals.length,
        view: VIEW_TITLES[c.view],
      },
      width,
    ).map((l) => `\x1b[44m\x1b[97m${l.padEnd(width)}\x1b[0m`);
    const view = this.views[c.view];
    const body = view ? view.render(width) : [];
    const status = renderStatusBar(c.view, c.statusFlash, width).map(
      (l) => `\x1b[7m${l.padEnd(width)}\x1b[0m`,
    );
    c.statusFlash = null;
    return [...header, ...body, ...status];
  }

  handleInput(data: string): void {
    const c = this.controller;
    if (matchesKey(data, "ctrl+p")) {
      this.openPalette();
      return;
    }
    if (matchesKey(data, "ctrl+1")) return this.go("sessions");
    if (matchesKey(data, "ctrl+2")) return this.go("diff");
    if (matchesKey(data, "ctrl+3")) return this.go("models");
    if (matchesKey(data, "ctrl+4")) return this.go("logs");
    if (matchesKey(data, "ctrl+,")) return this.go("settings");
    if (matchesKey(data, "ctrl+n")) {
      fire(this.newSessionFlow());
      return;
    }
    if (c.view === "chat") {
      if (matchesKey(data, "ctrl+b")) {
        fire(this.branchFlow());
        return;
      }
      if (matchesKey(data, "ctrl+m")) {
        fire(this.modelPickerFlow());
        return;
      }
      if (matchesKey(data, "ctrl+a")) return this.go("approvals");
      if (matchesKey(data, "escape")) {
        if (c.chat.activeRun) fire(c.interrupt());
        else this.go("sessions");
        return;
      }
    } else if (matchesKey(data, "escape") && c.view !== "sessions") {
      this.go("sessions");
      return;
    }
    const view = this.views[c.view];
    view?.handleInput?.(data);
  }

  private go(view: ViewName): void {
    fire(this.controller.setView(view));
  }

  // ── overlays ────────────────────────────────────────────────────────────

  private openPalette(): void {
    let handle: OverlayHandle | null = null;
    const overlay = new PaletteOverlay(
      (spec) => fire(this.executePaletteCommand(spec)),
      () => handle?.hide(),
    );
    handle = this.tui.showOverlay(overlay, {
      width: "70%",
      minWidth: 40,
      anchor: "top-center",
      margin: { top: 1 },
    });
  }

  private openInput(title: string, onSubmit: (text: string) => void, initial = ""): void {
    let handle: OverlayHandle | null = null;
    const overlay = new InputOverlay(title, onSubmit, () => handle?.hide(), initial);
    handle = this.tui.showOverlay(overlay, {
      width: "70%",
      minWidth: 40,
      anchor: "top-center",
      margin: { top: 1 },
    });
  }

  private openSelect(
    title: string,
    items: Array<{ value: string; label: string; description?: string }>,
    onSelect: (item: { value: string; label: string; description?: string }) => void,
  ): void {
    if (items.length === 0) {
      this.controller.flash("nothing to pick from");
      return;
    }
    let handle: OverlayHandle | null = null;
    const overlay = new SelectOverlay(title, items, onSelect, () => handle?.hide());
    handle = this.tui.showOverlay(overlay, {
      width: "70%",
      minWidth: 40,
      anchor: "top-center",
      margin: { top: 1 },
    });
  }

  // ── flows ───────────────────────────────────────────────────────────────

  private async newSessionFlow(): Promise<void> {
    const c = this.controller;
    const workspaces = await c.listWorkspaces();
    if (workspaces.length === 0) {
      c.flash("no workspaces registered — register one via the CLI first");
      return;
    }
    this.openSelect(
      "New session — pick a workspace",
      workspaces.map((w) => ({ value: w.id, label: w.name, description: w.roots.join(", ") })),
      (item) =>
        fire(
          (async () => {
            const session = await c.createSession(item.value);
            await c.openSession(session.id);
          })(),
        ),
    );
  }

  private async branchFlow(): Promise<void> {
    const c = this.controller;
    if (!c.currentSession) return;
    const messages = await c.listCurrentMessages();
    const items = messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({
        value: m.id,
        label: truncate(
          `${m.role === "user" ? "❯" : "•"} ${m.parts
            .filter((p) => p.type === "text")
            .map((p) => p.text ?? "")
            .join(" ")
            .replaceAll("\n", " ")}`,
          60,
        ),
        description: m.createdAt,
      }));
    this.openSelect("Branch from message", items, (item) => fire(c.branchFromMessage(item.value)));
  }

  private async modelPickerFlow(): Promise<void> {
    const c = this.controller;
    if (c.models.models.length === 0) await c.loadModels();
    this.openSelect(
      "Switch primary model",
      c.models.models.map((m) => ({ value: m.id, label: m.displayName, description: m.id })),
      (item) => fire(c.setRoleBinding("primary", item.value)),
    );
  }

  /** Palette command execution: interactive commands get pickers here. */
  private async executePaletteCommand(spec: CommandSpec): Promise<void> {
    const c = this.controller;
    switch (spec.id) {
      case "view.palette":
        this.openPalette();
        return;
      case "session.new":
        await this.newSessionFlow();
        return;
      case "session.rename": {
        const s = c.currentSession ?? c.sessions.selectedSession();
        if (!s) {
          c.flash("no session selected");
          return;
        }
        this.openInput(`Rename "${s.title}"`, (text) => fire(c.renameSession(s.id, text)), s.title);
        return;
      }
      case "session.branch":
        await this.branchFlow();
        return;
      case "session.export": {
        if (!c.currentSession) {
          c.flash("open a session first");
          return;
        }
        this.openSelect(
          "Export format",
          [
            { value: "markdown", label: "Markdown" },
            { value: "json", label: "JSON" },
          ],
          (item) =>
            fire(
              (async () => {
                const res = await c.exportCurrentSession(item.value as "json" | "markdown");
                c.flash(res ? `exported: ${res}` : "export failed");
              })(),
            ),
        );
        return;
      }
      case "agent.steer":
        this.openInput("Steer the running agent", (text) => fire(c.steer(text)));
        return;
      case "model.switch":
        await this.modelPickerFlow();
        return;
      case "provider.test": {
        if (c.models.providers.length === 0) await c.loadModels();
        this.openSelect(
          "Test provider",
          c.models.providers.map((p) => ({ value: p.id, label: p.displayName, description: p.kind })),
          (item) => fire(c.testProvider(item.value)),
        );
        return;
      }
      case "checkpoint.restore": {
        const checkpoints = await c.listCheckpoints();
        this.openSelect(
          "Restore checkpoint",
          checkpoints.map((cp) => ({ value: cp.id, label: cp.label, description: cp.kind })),
          (item) => fire(c.restoreCheckpoint(item.value)),
        );
        return;
      }
      case "memory.search":
        this.openInput("Search memory", (text) =>
          fire(
            (async () => {
              await c.loadMemory(text || undefined);
              await c.setView("memory");
            })(),
          ),
        );
        return;
      default:
        await c.executeCommand(spec);
        return;
    }
  }
}
