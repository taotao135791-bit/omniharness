import type { Automation, AutomationRun } from "@omniharness/agent-protocol";
import { fmtDate, fmtTime, truncate } from "./layout.js";
import { SelectableList } from "./selectable-list.js";

function describeTrigger(a: Automation): string {
  const t = a.trigger;
  switch (t.kind) {
    case "once":
    case "file_change":
    case "git_change":
    case "webhook":
    case "app_launch":
    case "manual":
      return t.kind;
    case "cron":
      return `cron:${t.expression}`;
  }
}

/** Automations view-model: list with enable state and last-run status. */
export class AutomationsViewModel {
  automations: Automation[] = [];
  lastRuns = new Map<string, AutomationRun>();
  loading = false;
  error: string | null = null;
  readonly list = new SelectableList();

  setData(automations: Automation[], runs: AutomationRun[]): void {
    this.automations = automations;
    this.lastRuns = new Map(runs.map((r) => [r.automationId, r]));
    this.loading = false;
    this.error = null;
    this.list.setRows(
      automations.map((a) => {
        const last = this.lastRuns.get(a.id);
        const lastStr = last
          ? `${last.status} ${fmtDate(last.startedAt)} ${fmtTime(last.startedAt)}`
          : "never run";
        return {
          id: a.id,
          label: `${a.enabled ? "●" : "○"} ${a.name}`,
          detail: `${describeTrigger(a)}  last: ${lastStr}`,
        };
      }),
    );
  }

  setError(message: string): void {
    this.loading = false;
    this.error = message;
  }

  /** Optimistically reflect automation.updated events. */
  upsert(automation: Automation): void {
    const idx = this.automations.findIndex((a) => a.id === automation.id);
    const next = [...this.automations];
    if (idx === -1) next.push(automation);
    else next[idx] = automation;
    this.setData(next, [...this.lastRuns.values()]);
  }

  selected(): Automation | undefined {
    const row = this.list.selectedRow();
    return row ? this.automations.find((a) => a.id === row.id) : undefined;
  }

  renderLines(width: number, maxVisible: number): string[] {
    if (this.loading) return ["  loading automations…"];
    if (this.error) return [truncate(`  error: ${this.error}`, width)];
    if (this.automations.length === 0) return ["  no automations configured"];
    return this.list.renderLines(width, maxVisible);
  }
}
