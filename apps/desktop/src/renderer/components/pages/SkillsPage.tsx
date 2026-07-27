import React from "react";
import type { AppStore } from "../../store.js";
import { useQuery } from "../../hooks.js";

export function SkillsPage({ store }: { store: AppStore }): React.JSX.Element {
  const skills = useQuery(store, () => store.rpc.call("skill.list", {}), [], true);
  const proposals = useQuery(
    store,
    () => store.rpc.call("skill.proposals", { status: "pending" }),
    [],
    true,
  );

  const refreshAll = () => {
    skills.refresh();
    proposals.refresh();
  };

  const pending = proposals.data?.proposals ?? [];

  return (
    <section className="page" aria-label="Skills">
      <h1>Skills</h1>

      {pending.length > 0 && (
        <>
          <h2 className="page-h2">Pending proposals</h2>
          {pending.map((p) => (
            <div key={p.id} className="card proposal">
              <div className="card-head">
                <strong>{p.skill.name}</strong>
                <span className="badge risk-medium">proposal</span>
                <span className="muted">v{p.skill.version}</span>
              </div>
              <div className="muted">{p.skill.description}</div>
              {p.diff && <pre className="proposal-diff">{p.diff}</pre>}
              {p.testResult && (
                <div className={p.testResult.passed ? "ok-text" : "error-text"}>
                  self-test {p.testResult.passed ? "passed" : "failed"}: {p.testResult.output}
                </div>
              )}
              <div className="row-actions">
                <button
                  className="mini approve"
                  aria-label={`Approve skill ${p.skill.name}`}
                  onClick={() =>
                    void store.rpc
                      .call("skill.approveProposal", { proposalId: p.id })
                      .then(refreshAll)
                  }
                >
                  Approve
                </button>
                <button
                  className="mini deny"
                  aria-label={`Reject skill ${p.skill.name}`}
                  onClick={() =>
                    void store.rpc
                      .call("skill.rejectProposal", { proposalId: p.id })
                      .then(refreshAll)
                  }
                >
                  Reject
                </button>
              </div>
            </div>
          ))}
        </>
      )}

      <h2 className="page-h2">Installed skills</h2>
      {(skills.data?.skills ?? []).map((sk) => (
        <div key={sk.id} className="card">
          <div className="card-head">
            <strong>{sk.name}</strong>
            <span className="muted">v{sk.version}</span>
            <span className="badge">{sk.scope}</span>
            <span className="badge">{sk.source}</span>
            <label className="toggle">
              <input
                type="checkbox"
                aria-label={`Enable ${sk.name}`}
                checked={sk.enabled}
                onChange={(e) =>
                  void store.rpc
                    .call("skill.setEnabled", { skillId: sk.id, enabled: e.target.checked })
                    .then(refreshAll)
                }
              />
              enabled
            </label>
          </div>
          <div className="muted">{sk.description}</div>
          {sk.requiredCapabilities.length > 0 && (
            <div className="muted">requires: {sk.requiredCapabilities.join(", ")}</div>
          )}
        </div>
      ))}
      {skills.data && skills.data.skills.length === 0 && (
        <div className="hint">No skills installed.</div>
      )}
    </section>
  );
}
