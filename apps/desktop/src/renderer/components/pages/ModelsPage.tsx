import React, { useState } from "react";
import type { AppStore } from "../../store.js";
import { useAppState, useQuery } from "../../hooks.js";
import type { ModelRole } from "@omniharness/shared-types";
import {
  ROLE_LIST,
  bindingRows,
  capabilityBadges,
  editBinding,
  formatContextWindow,
  formatPrice,
  groupByProvider,
} from "../../vm/models.js";

export function ModelsPage({ store }: { store: AppStore }): React.JSX.Element {
  useAppState(store); // re-render on dataRevision bumps via useQuery below
  const [testResults, setTestResults] = useState<
    Record<string, { ok: boolean; latencyMs: number; error?: string }>
  >({});
  const [testing, setTesting] = useState<string | null>(null);
  const [edits, setEdits] = useState<Partial<Record<ModelRole, string | null>>>({});

  const providers = useQuery(store, () => store.rpc.call("provider.list", {}), [], true);
  const models = useQuery(store, () => store.rpc.call("model.list", {}), [], true);
  const bindings = useQuery(store, () => store.rpc.call("model.getRoleBindings", {}), [], true);

  const groups = groupByProvider(providers.data?.providers ?? [], models.data?.models ?? []);
  const rows = bindingRows(bindings.data?.bindings ?? {}, edits);
  const allModels = models.data?.models ?? [];

  const testProvider = async (providerId: string) => {
    setTesting(providerId);
    try {
      const r = await store.rpc.call("provider.test", { providerId });
      const entry: { ok: boolean; latencyMs: number; error?: string } = {
        ok: r.ok,
        latencyMs: r.latencyMs,
      };
      if (r.error !== undefined) entry.error = r.error;
      setTestResults((prev) => ({ ...prev, [providerId]: entry }));
    } finally {
      setTesting(null);
    }
  };

  const saveBinding = async (role: ModelRole) => {
    const modelId = edits[role];
    if (modelId === undefined) return;
    await store.rpc.call("model.setRoleBinding", { role, modelId, scope: "profile" });
    setEdits((prev) => {
      const next = { ...prev };
      delete next[role];
      return next;
    });
    bindings.refresh();
  };

  return (
    <section className="page" aria-label="Models">
      <h1>Models</h1>

      <h2 className="page-h2">Providers</h2>
      {groups.map((g) => {
        const test = testResults[g.provider.id];
        return (
          <div key={g.provider.id} className="card">
            <div className="card-head">
              <strong>{g.provider.displayName}</strong>
              <span className="badge">{g.provider.kind}</span>
              {!g.provider.enabled && <span className="badge status-failed">disabled</span>}
              <button
                className="mini"
                disabled={testing === g.provider.id}
                aria-label={`Test provider ${g.provider.displayName}`}
                onClick={() => void testProvider(g.provider.id)}
              >
                {testing === g.provider.id ? "testing…" : "Test"}
              </button>
              {test && (
                <span className={`badge ${test.ok ? "status-completed" : "status-failed"}`}>
                  {test.ok ? `ok · ${test.latencyMs}ms` : (test.error ?? "failed")}
                </span>
              )}
            </div>
            {g.models.map((m) => (
              <div key={m.id} className="model-row">
                <span className="model-name">{m.displayName}</span>
                <span className="muted">{m.remoteName}</span>
                {capabilityBadges(m).map((b) => (
                  <span key={b.key} className="badge cap">
                    {b.label}
                  </span>
                ))}
                <span className="muted">{formatContextWindow(m.capabilities.contextWindow)}</span>
                <span className="muted">{formatPrice(m)}</span>
              </div>
            ))}
            {g.models.length === 0 && <div className="hint">No models registered.</div>}
          </div>
        );
      })}
      {groups.length === 0 && !providers.loading && (
        <div className="hint">No providers configured. Add one via the CLI or config file.</div>
      )}

      <h2 className="page-h2">Role bindings</h2>
      <div className="card">
        {rows.map((row) => (
          <div key={row.role} className="binding-row">
            <span className="binding-role">{row.role}</span>
            <select
              aria-label={`Model for ${row.role}`}
              value={row.modelId ?? ""}
              onChange={(e) =>
                setEdits((prev) => editBinding(prev, row.role, e.target.value || null))
              }
            >
              <option value="">— unbound —</option>
              {allModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.displayName}
                </option>
              ))}
            </select>
            <button
              className="mini"
              disabled={!row.dirty}
              aria-label={`Save binding for ${row.role}`}
              onClick={() => void saveBinding(row.role)}
            >
              Save
            </button>
          </div>
        ))}
        <div className="hint">Bindings apply at profile scope. {ROLE_LIST.length} roles.</div>
      </div>
    </section>
  );
}
