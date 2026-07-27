import { matchesKey, type Component } from "@earendil-works/pi-tui";
import type { AppController } from "../core/app-controller.js";
import { ListViewComponent, styleLine } from "./list-view.js";
import type { ShellActions } from "./shell-actions.js";
import { dim, fg } from "../theme.js";
import { parseValue } from "../vm/settings-vm.js";
import { EDITABLE_ROLES } from "../vm/models-vm.js";

function fire(promise: Promise<unknown>): void {
  void promise.catch(() => undefined);
}

// ── sessions ──────────────────────────────────────────────────────────────

export class SessionsView extends ListViewComponent {
  constructor(
    private readonly controller: AppController,
    private readonly actions: ShellActions,
  ) {
    super(controller.sessions, (data) => this.handleKey(data));
  }

  private handleKey(data: string): void {
    const c = this.controller;
    if (matchesKey(data, "enter")) {
      const s = c.sessions.selectedSession();
      if (s) fire(c.openSession(s.id));
      return;
    }
    if (data === "n") {
      fire(this.pickWorkspaceAndCreate());
      return;
    }
    if (data === "r") {
      const s = c.sessions.selectedSession();
      if (!s) return;
      this.actions.openInput(
        `Rename "${s.title}"`,
        (text) => fire(c.renameSession(s.id, text)),
        s.title,
      );
      return;
    }
    if (data === "t") {
      const s = c.sessions.selectedSession();
      if (!s) return;
      this.actions.openInput(
        "Tags (comma separated)",
        (text) =>
          fire(
            c.setSessionTags(
              s.id,
              text
                .split(",")
                .map((t) => t.trim())
                .filter(Boolean),
            ),
          ),
        s.tags.join(", "),
      );
      return;
    }
    if (data === "x") {
      const s = c.sessions.selectedSession();
      if (s) fire(c.archiveSession(s.id));
      return;
    }
    if (data === "]") {
      fire(c.nextSessionPage());
      return;
    }
    if (data === "[") {
      fire(c.prevSessionPage());
      return;
    }
  }

  private async pickWorkspaceAndCreate(): Promise<void> {
    const c = this.controller;
    const workspaces = await c.listWorkspaces();
    if (workspaces.length === 0) {
      c.flash("no workspaces registered — register one via the CLI first");
      return;
    }
    this.actions.openSelect(
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
}

// ── approvals ─────────────────────────────────────────────────────────────

export class ApprovalsView extends ListViewComponent {
  constructor(private readonly controller: AppController) {
    super(controller.approvals, (data) => this.handleKey(data));
  }

  private handleKey(data: string): void {
    const c = this.controller;
    const a = c.approvals.selected();
    if (data === "r") {
      fire(c.refreshApprovals());
      return;
    }
    if (!a) return;
    if (data === "a") fire(c.resolveApproval(a.id, "approve", "once"));
    else if (data === "s") fire(c.resolveApproval(a.id, "approve", "session"));
    else if (data === "w") fire(c.resolveApproval(a.id, "approve", "workspace"));
    else if (data === "y") fire(c.resolveApproval(a.id, "approve", "always"));
    else if (data === "d") fire(c.resolveApproval(a.id, "deny", "once"));
  }
}

// ── diff ──────────────────────────────────────────────────────────────────

export class DiffView extends ListViewComponent {
  constructor(private readonly controller: AppController) {
    super(controller.diff, (data) => this.handleKey(data));
  }

  override render(width: number): string[] {
    const lines = super.render(width);
    const hunkLines = this.controller.diff.selectedHunkLines();
    if (hunkLines.length > 0) {
      lines.push(dim("  ─".padEnd(Math.min(width, 40), "─")));
      for (const l of hunkLines.slice(0, 30)) {
        if (l.startsWith("+")) lines.push(fg.green(l));
        else if (l.startsWith("-")) lines.push(fg.red(l));
        else lines.push(dim(l));
      }
    }
    return lines;
  }

  private handleKey(data: string): void {
    const c = this.controller;
    if (matchesKey(data, "enter")) {
      c.diff.toggleSelected();
      return;
    }
    if (data === "r") {
      fire(c.loadDiff());
      return;
    }
    if (data === "A") {
      fire(c.diffResolve("accept", "all"));
      return;
    }
    if (data === "D") {
      fire(c.diffResolve("reject", "all"));
      return;
    }
    const target = c.diff.selectedTarget();
    if (!target) return;
    if (data === "a") fire(c.diffResolve("accept", target));
    else if (data === "d") fire(c.diffResolve("reject", target));
  }
}

// ── models ────────────────────────────────────────────────────────────────

export class ModelsView extends ListViewComponent {
  constructor(
    private readonly controller: AppController,
    private readonly actions: ShellActions,
  ) {
    super(controller.models, (data) => this.handleKey(data));
  }

  private handleKey(data: string): void {
    const c = this.controller;
    if (data === "r") {
      fire(c.loadModels());
      return;
    }
    if (data === "p") {
      const m = c.models.selectedModel();
      if (m) fire(c.setRoleBinding("primary", m.id));
      return;
    }
    if (data === "t") {
      const p = c.models.selectedProvider();
      if (p) fire(c.testProvider(p.id));
      return;
    }
    if (data === "b") {
      this.actions.openSelect(
        "Role bindings — pick a role",
        EDITABLE_ROLES.map((role) => ({
          value: role,
          label: role,
          description: c.models.bindings[role]
            ? c.models.modelDisplayName(c.models.bindings[role]!)
            : "(default)",
        })),
        (roleItem) => {
          const role = roleItem.value as (typeof EDITABLE_ROLES)[number];
          this.actions.openSelect(
            `Bind ${role} to model`,
            [
              { value: "", label: "(clear binding)", description: "fall back to default" },
              ...c.models.models.map((m) => ({
                value: m.id,
                label: m.displayName,
                description: m.id,
              })),
            ],
            (modelItem) => fire(c.setRoleBinding(role, modelItem.value === "" ? null : modelItem.value)),
          );
        },
      );
      return;
    }
  }
}

// ── memory ────────────────────────────────────────────────────────────────

export class MemoryView extends ListViewComponent {
  constructor(
    private readonly controller: AppController,
    private readonly actions: ShellActions,
  ) {
    super(controller.memory, (data) => this.handleKey(data));
  }

  private handleKey(data: string): void {
    const c = this.controller;
    if (data === "/") {
      this.actions.openInput("Search memory", (text) => fire(c.loadMemory(text || undefined)));
      return;
    }
    if (data === "r") {
      fire(c.loadMemory());
      return;
    }
    const m = c.memory.selected();
    if (!m) return;
    if (data === "a") fire(c.memoryAction("approve", m.id));
    else if (data === "d") fire(c.memoryAction("reject", m.id));
    else if (data === "x") fire(c.memoryAction("delete", m.id));
  }
}

// ── skills ────────────────────────────────────────────────────────────────

export class SkillsView extends ListViewComponent {
  constructor(private readonly controller: AppController) {
    super(controller.skills, (data) => this.handleKey(data));
  }

  private handleKey(data: string): void {
    const c = this.controller;
    if (data === "r") {
      fire(c.loadSkills());
      return;
    }
    if (matchesKey(data, "space")) {
      const s = c.skills.selectedSkill();
      if (s) fire(c.toggleSkill(s.id, !s.enabled));
      return;
    }
    const p = c.skills.selectedProposal();
    if (!p) return;
    if (data === "a") fire(c.resolveSkillProposal(p.id, true));
    else if (data === "d") fire(c.resolveSkillProposal(p.id, false));
  }
}

// ── automations ───────────────────────────────────────────────────────────

export class AutomationsView extends ListViewComponent {
  constructor(private readonly controller: AppController) {
    super(controller.automations, (data) => this.handleKey(data));
  }

  private handleKey(data: string): void {
    const c = this.controller;
    if (data === "r") {
      fire(c.loadAutomations());
      return;
    }
    const a = c.automations.selected();
    if (!a) return;
    if (matchesKey(data, "space")) fire(c.toggleAutomation(a.id, !a.enabled));
    else if (matchesKey(data, "enter")) fire(c.runAutomationNow(a.id));
  }
}

// ── settings ──────────────────────────────────────────────────────────────

export class SettingsView extends ListViewComponent {
  constructor(
    private readonly controller: AppController,
    private readonly actions: ShellActions,
  ) {
    super(controller.settings, (data) => this.handleKey(data));
  }

  private handleKey(data: string): void {
    const c = this.controller;
    if (data === "r") {
      fire(c.loadSettings());
      return;
    }
    if (!matchesKey(data, "enter") && !matchesKey(data, "space")) return;
    const row = c.settings.selected();
    if (!row) return;
    if (row.field.type === "boolean" || row.field.type === "enum") {
      const value = c.settings.cycleValue(row.field.key, 1);
      if (value !== undefined) fire(c.saveSetting(row.field.key, value));
      return;
    }
    this.actions.openInput(
      `${row.field.key} (${row.field.type})`,
      (text) => {
        try {
          const value = parseValue(row.field, text);
          fire(c.saveSetting(row.field.key, value));
        } catch (err) {
          c.settings.statusLine = `invalid value: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
      row.value === undefined ? "" : String(row.value),
    );
  }
}

// ── logs ──────────────────────────────────────────────────────────────────

export class LogsView implements Component {
  focused = false;

  constructor(private readonly controller: AppController) {}

  invalidate(): void {}

  render(width: number): string[] {
    return this.controller.logs.renderLines(width, this.controller.diagLog, 30).map(styleLine);
  }

  handleInput(data: string): void {
    if (data === "r") fire(this.controller.loadDiagnostics());
  }
}
