import React, { useState } from "react";
import type { Automation } from "@omniharness/agent-protocol";
import type { AppStore } from "../../store.js";
import { useQuery } from "../../hooks.js";
import { formatDuration, formatTime } from "../../vm/timeline.js";

function triggerLabel(a: Automation): string {
  const t = a.trigger;
  switch (t.kind) {
    case "once":
      return `once at ${t.at}`;
    case "cron":
      return `cron: ${t.expression}`;
    case "file_change":
      return `file change: ${t.pathGlob}`;
    case "git_change":
      return `git change${t.ref ? `: ${t.ref}` : ""}`;
    case "webhook":
      return `webhook: ${t.endpointId}`;
    case "app_launch":
      return "on app launch";
    case "manual":
      return "manual";
  }
}

function AutomationCard({
  store,
  automation,
  onChanged,
}: {
  store: AppStore;
  automation: Automation;
  onChanged: () => void;
}): React.JSX.Element {
  const [showRuns, setShowRuns] = useState(false);
  const runs = useQuery(
    store,
    () =>
      showRuns
        ? store.rpc.call("automation.runs", { automationId: automation.id, limit: 20 })
        : Promise.resolve(null),
    [showRuns],
    true,
  );

  return (
    <div className="card">
      <div className="card-head">
        <strong>{automation.name}</strong>
        <span className="badge">{triggerLabel(automation)}</span>
        <label className="toggle">
          <input
            type="checkbox"
            aria-label={`Enable ${automation.name}`}
            checked={automation.enabled}
            onChange={(e) =>
              void store.rpc
                .call("automation.setEnabled", {
                  automationId: automation.id,
                  enabled: e.target.checked,
                })
                .then(onChanged)
            }
          />
          enabled
        </label>
        <button
          className="mini"
          aria-label={`Run ${automation.name} now`}
          onClick={() =>
            void store.rpc
              .call("automation.runNow", { automationId: automation.id })
              .then(onChanged)
          }
        >
          Run now
        </button>
        <button
          className="mini"
          aria-expanded={showRuns}
          aria-label={`Toggle run history for ${automation.name}`}
          onClick={() => setShowRuns((v) => !v)}
        >
          {showRuns ? "Hide runs" : "Runs"}
        </button>
        <button
          className="mini deny"
          aria-label={`Delete ${automation.name}`}
          onClick={() =>
            void store.rpc
              .call("automation.delete", { automationId: automation.id })
              .then(onChanged)
          }
        >
          Delete
        </button>
      </div>
      <div className="muted">{automation.description}</div>
      <div className="muted">
        last run: {automation.lastRunAt ? formatTime(automation.lastRunAt) : "never"}
        {automation.nextRunAt && ` · next: ${formatTime(automation.nextRunAt)}`}
      </div>
      {showRuns && (
        <div className="run-history">
          {(runs.data?.runs ?? []).map((r) => (
            <div key={r.id} className="approval-row">
              <span className={`badge status-${r.status}`}>{r.status}</span>
              <span className="muted">{formatTime(r.startedAt)}</span>
              <span className="muted">
                {r.endedAt
                  ? formatDuration(Math.max(0, Date.parse(r.endedAt) - Date.parse(r.startedAt)))
                  : "…"}
              </span>
              <span>{r.resultSummary ?? r.error ?? ""}</span>
            </div>
          ))}
          {runs.data && runs.data.runs.length === 0 && <div className="hint">No runs yet.</div>}
        </div>
      )}
    </div>
  );
}

export function AutomationsPage({ store }: { store: AppStore }): React.JSX.Element {
  const automations = useQuery(store, () => store.rpc.call("automation.list", {}), [], true);
  return (
    <section className="page" aria-label="Automations">
      <h1>Automations</h1>
      {(automations.data?.automations ?? []).map((a) => (
        <AutomationCard key={a.id} store={store} automation={a} onChanged={automations.refresh} />
      ))}
      {automations.data && automations.data.automations.length === 0 && (
        <div className="hint">No automations configured.</div>
      )}
    </section>
  );
}
