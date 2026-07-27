import type { DiagnosticsReport } from "@omniharness/agent-protocol";
import { fmtTime, truncate } from "./layout.js";

export interface DiagnosticEvent {
  at: string;
  level: "info" | "warn" | "error";
  message: string;
}

/** Ring buffer of recent diagnostic events from the daemon event stream. */
export class DiagnosticLog {
  private events: DiagnosticEvent[] = [];
  constructor(private readonly capacity = 200) {}

  push(ev: DiagnosticEvent): void {
    this.events.push(ev);
    if (this.events.length > this.capacity)
      this.events.splice(0, this.events.length - this.capacity);
  }

  recent(limit: number): DiagnosticEvent[] {
    return this.events.slice(-limit);
  }

  clear(): void {
    this.events = [];
  }
}

/** Logs/diagnostics view-model: system.diagnostics + recent diagnostic events. */
export class LogsViewModel {
  report: DiagnosticsReport | null = null;
  loading = false;
  error: string | null = null;

  setReport(report: DiagnosticsReport): void {
    this.report = report;
    this.loading = false;
    this.error = null;
  }

  setError(message: string): void {
    this.loading = false;
    this.error = message;
  }

  renderLines(width: number, diag: DiagnosticLog, maxEvents: number): string[] {
    const lines: string[] = [];
    if (this.loading) lines.push("  running diagnostics…");
    else if (this.error) lines.push(truncate(`  error: ${this.error}`, width));
    else if (this.report) {
      const r = this.report;
      lines.push(
        truncate(
          `  daemon ${r.ok ? "OK" : "DEGRADED"}  ${r.platform.os}/${r.platform.arch} node ${r.platform.node}`,
          width,
        ),
      );
      lines.push(
        truncate(
          `  data: ${r.dataDir}  db ${(r.dbSizeBytes / 1024).toFixed(0)}KiB  event log ${r.eventLogSize}`,
          width,
        ),
      );
      for (const c of r.checks) {
        lines.push(truncate(`  ${c.ok ? "✓" : "✗"} ${c.name} — ${c.detail}`, width));
      }
    } else {
      lines.push("  press [r] to run diagnostics");
    }
    lines.push("");
    lines.push(truncate("  recent daemon events:", width));
    const events = diag.recent(maxEvents);
    if (events.length === 0) lines.push("  (none)");
    for (const e of events) {
      lines.push(truncate(`  ${fmtTime(e.at)} [${e.level}] ${e.message}`, width));
    }
    return lines;
  }
}
