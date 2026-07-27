import React, { useState } from "react";
import type { AppStore } from "../../store.js";
import { useAppState, useQuery } from "../../hooks.js";
import { formatBytes, toUsageBars, totalUsage } from "../../vm/usage.js";
import { formatTokens } from "../../vm/chat.js";

type GroupBy = "model" | "project" | "agent" | "automation";

export function DiagnosticsPage({ store }: { store: AppStore }): React.JSX.Element {
  const s = useAppState(store);
  const [groupBy, setGroupBy] = useState<GroupBy>("model");
  const usage = useQuery(
    store,
    () => store.rpc.call("usage.summary", { groupBy }),
    [groupBy],
    true,
  );

  const bars = toUsageBars(usage.data?.usage ?? []);
  const totals = totalUsage(usage.data?.usage ?? []);
  const report = s.diagnostics;

  return (
    <section className="page" aria-label="Diagnostics">
      <h1>Diagnostics</h1>

      <div className="row-actions">
        <button onClick={() => void store.refreshDiagnostics()} aria-label="Re-run diagnostics">
          Re-run checks
        </button>
        {report && (
          <span className={`badge ${report.ok ? "status-completed" : "status-failed"}`}>
            {report.ok ? "all checks pass" : "failures detected"}
          </span>
        )}
      </div>

      {report && (
        <>
          <div className="card">
            <div className="muted">
              {report.platform.os} / {report.platform.arch} · node {report.platform.node} · data
              dir <code>{report.dataDir}</code> · db {formatBytes(report.dbSizeBytes)} · event log{" "}
              {report.eventLogSize} events
            </div>
          </div>
          {report.checks.map((c) => (
            <div key={c.name} className="problem-row">
              <span className={`badge ${c.ok ? "status-completed" : "status-failed"}`}>
                {c.ok ? "ok" : "fail"}
              </span>
              <strong>{c.name}</strong>
              <span className="muted">{c.detail}</span>
            </div>
          ))}
        </>
      )}

      <h2 className="page-h2">Usage &amp; cost</h2>
      <div className="row-actions" role="group" aria-label="Group usage by">
        {(["model", "project", "agent", "automation"] as const).map((g) => (
          <button
            key={g}
            className={`mini ${groupBy === g ? "primary" : ""}`}
            aria-pressed={groupBy === g}
            onClick={() => setGroupBy(g)}
          >
            by {g}
          </button>
        ))}
      </div>
      <div className="card">
        <div className="muted">
          total: {formatTokens(totals.inputTokens)} in · {formatTokens(totals.outputTokens)} out ·{" "}
          {totals.requests} requests
          {totals.hasCost && ` · $${totals.costUsd.toFixed(4)}`}
        </div>
        {bars.map((b) => (
          <div key={b.key} className="usage-row">
            <div className="usage-key" title={b.key}>
              {b.key}
            </div>
            <div className="usage-bar-track">
              <div className="usage-bar" style={{ width: `${Math.round(b.width * 100)}%` }} />
            </div>
            <div className="usage-val muted">
              {formatTokens(b.totalTokens)} · {b.requests} req
              {b.costUsd !== null && ` · $${b.costUsd.toFixed(3)}`}
            </div>
          </div>
        ))}
        {bars.length === 0 && !usage.loading && <div className="hint">No usage recorded yet.</div>}
      </div>
    </section>
  );
}
