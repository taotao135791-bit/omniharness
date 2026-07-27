import type { AgentRun } from "@omniharness/shared-types";
import type { ToolCallState } from "./chat.js";

/**
 * Run-timeline view-model: merges run.list rows with live tool-call state
 * into renderable timeline entries.
 */

export interface RunRow {
  id: string;
  status: AgentRun["status"];
  startedAt: string;
  durationMs: number | null;
  error: string | null;
  inputTokens: number;
  outputTokens: number;
  active: boolean;
}

export function runRows(runs: AgentRun[], activeRunId: string | null): RunRow[] {
  return [...runs]
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .map((r) => ({
      id: r.id,
      status: r.id === activeRunId ? "running" : r.status,
      startedAt: r.startedAt,
      durationMs:
        r.endedAt !== null
          ? Math.max(0, Date.parse(r.endedAt) - Date.parse(r.startedAt))
          : null,
      error: r.error ?? null,
      inputTokens: r.usage.inputTokens,
      outputTokens: r.usage.outputTokens,
      active: r.id === activeRunId,
    }));
}

export interface ToolCallRow {
  id: string;
  name: string;
  status: ToolCallState["status"];
  durationMs: number | null;
}

export function toolCallRows(toolCalls: ToolCallState[]): ToolCallRow[] {
  return [...toolCalls]
    .sort((a, b) => b.seq - a.seq)
    .map((t) => ({ id: t.id, name: t.name, status: t.status, durationMs: t.durationMs }));
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return "…";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(undefined, { hour12: false });
}
