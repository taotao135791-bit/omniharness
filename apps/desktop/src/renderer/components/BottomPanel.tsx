import React, { useEffect, useRef } from "react";
import type { AppStore, BottomTab } from "../store.js";
import { useAppState } from "../hooks.js";
import { diagnosticsProblems } from "../vm/usage.js";

const TABS: Array<{ id: BottomTab; label: string }> = [
  { id: "logs", label: "Logs" },
  { id: "approvals", label: "Approvals" },
  { id: "problems", label: "Problems" },
];

export function BottomPanel({ store }: { store: AppStore }): React.JSX.Element {
  const s = useAppState(store);
  const logEndRef = useRef<HTMLDivElement>(null);
  const problems = diagnosticsProblems(s.diagnostics);
  const pending = s.approvals.filter((a) => a.status === "pending");

  useEffect(() => {
    if (s.bottomTab === "logs" && s.bottomOpen) {
      logEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [s.logs.length, s.bottomTab, s.bottomOpen]);

  return (
    <section
      className={`bottom-panel ${s.bottomOpen ? "" : "collapsed"}`}
      aria-label="Bottom panel"
    >
      <div className="tab-bar" role="tablist" aria-label="Bottom panel tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={s.bottomTab === t.id}
            className={`tab ${s.bottomTab === t.id ? "active" : ""}`}
            onClick={() => store.setBottomTab(t.id)}
          >
            {t.label}
            {t.id === "approvals" && pending.length > 0 && (
              <span className="count-badge">{pending.length}</span>
            )}
            {t.id === "problems" && problems.length > 0 && (
              <span className="count-badge danger">{problems.length}</span>
            )}
          </button>
        ))}
        <button
          className="tab collapse-btn"
          aria-label={s.bottomOpen ? "Collapse panel" : "Expand panel"}
          onClick={() => store.toggleBottom()}
        >
          {s.bottomOpen ? "▾" : "▴"}
        </button>
      </div>
      {s.bottomOpen && (
        <div className="bottom-body">
          {s.bottomTab === "logs" && (
            <div className="log-view" aria-label="Logs">
              {s.logs.map((l) => (
                <div key={l.id} className={`log-line ${l.level}`}>
                  <span className="muted">{new Date(l.at).toLocaleTimeString()}</span> {l.text}
                </div>
              ))}
              {s.logs.length === 0 && <div className="hint">No log lines yet.</div>}
              <div ref={logEndRef} />
            </div>
          )}
          {s.bottomTab === "approvals" && (
            <div aria-label="Pending approvals">
              {pending.map((a) => (
                <div key={a.id} className="approval-row">
                  <span className={`badge risk-${a.risk}`}>{a.risk}</span>
                  <strong>{a.capability}</strong>
                  <span className="approval-summary">{a.summary}</span>
                  <span className="approval-actions">
                    <button
                      className="mini approve"
                      aria-label={`Approve ${a.capability}`}
                      onClick={() => void store.resolveApproval(a.id, "approve")}
                    >
                      Approve
                    </button>
                    <button
                      className="mini deny"
                      aria-label={`Deny ${a.capability}`}
                      onClick={() => void store.resolveApproval(a.id, "deny")}
                    >
                      Deny
                    </button>
                  </span>
                </div>
              ))}
              {pending.length === 0 && <div className="hint">No pending approvals.</div>}
            </div>
          )}
          {s.bottomTab === "problems" && (
            <div aria-label="Problems">
              {problems.map((p) => (
                <div key={p.name} className="problem-row">
                  <span className="badge status-failed">fail</span> <strong>{p.name}</strong>{" "}
                  <span className="muted">{p.detail}</span>
                </div>
              ))}
              {problems.length === 0 && (
                <div className="hint">
                  {s.diagnostics ? "All diagnostics checks pass." : "Diagnostics not loaded yet."}
                </div>
              )}
              <button className="link-btn" onClick={() => void store.refreshDiagnostics()}>
                Re-run diagnostics
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
