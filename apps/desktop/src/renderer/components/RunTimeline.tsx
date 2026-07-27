import React from "react";
import type { AppStore } from "../store.js";
import { useAppState } from "../hooks.js";
import { formatDuration, formatTime, runRows, toolCallRows } from "../vm/timeline.js";
import { formatTokens } from "../vm/chat.js";

/** Runs + tool calls with durations and status, for the active session. */
export function RunTimeline({ store }: { store: AppStore }): React.JSX.Element {
  const s = useAppState(store);
  const runs = runRows(s.runs, s.chat.activeRunId);
  const tools = toolCallRows(s.chat.toolCalls);

  return (
    <aside className="timeline" aria-label="Run timeline">
      <h3>Timeline</h3>
      {runs.length === 0 && tools.length === 0 && <div className="hint">No runs yet.</div>}
      {runs.map((r) => (
        <div key={r.id} className={`tl-run ${r.active ? "active" : ""}`}>
          <div className="tl-row">
            <span className={`badge status-${r.status}`}>{r.status}</span>
            <span className="muted">{formatTime(r.startedAt)}</span>
            <span className="tl-dur">{formatDuration(r.durationMs)}</span>
          </div>
          <div className="tl-usage muted">
            {formatTokens(r.inputTokens + r.outputTokens)} tok
          </div>
          {r.error && <div className="error-text">{r.error}</div>}
        </div>
      ))}
      {tools.length > 0 && <h3>Tool calls</h3>}
      {tools.map((t) => (
        <div key={t.id} className="tl-row tl-tool">
          <span className={`badge status-${t.status}`}>{t.status}</span>
          <span className="tool-name">{t.name}</span>
          <span className="tl-dur muted">{formatDuration(t.durationMs)}</span>
        </div>
      ))}
    </aside>
  );
}
