import React, { useState } from "react";
import type { AppStore } from "../../store.js";
import { useQuery } from "../../hooks.js";

export function PluginsPage({ store }: { store: AppStore }): React.JSX.Element {
  const plugins = useQuery(store, () => store.rpc.call("plugin.list", {}), [], true);
  const [installPath, setInstallPath] = useState("");
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);

  const install = async () => {
    const path = installPath.trim();
    if (!path) return;
    setInstalling(true);
    setInstallError(null);
    try {
      await store.rpc.call("plugin.install", { path });
      setInstallPath("");
      plugins.refresh();
    } catch (err) {
      setInstallError(err instanceof Error ? err.message : String(err));
    } finally {
      setInstalling(false);
    }
  };

  return (
    <section className="page" aria-label="Plugins">
      <h1>Plugins</h1>

      <form
        className="search-bar"
        onSubmit={(e) => {
          e.preventDefault();
          void install();
        }}
      >
        <input
          aria-label="Plugin path"
          placeholder="Install from path… (/abs/path/to/plugin)"
          value={installPath}
          onChange={(e) => setInstallPath(e.target.value)}
        />
        <button type="submit" className="primary" disabled={installing || !installPath.trim()}>
          {installing ? "Installing…" : "Install"}
        </button>
      </form>
      {installError && <div className="error-text">{installError}</div>}

      {(plugins.data?.plugins ?? []).map((p) => (
        <div key={p.manifest.id} className="card">
          <div className="card-head">
            <strong>{p.manifest.name}</strong>
            <span className="muted">v{p.manifest.version}</span>
            <span className={`badge trust-${p.trust}`}>{p.trust}</span>
            <label className="toggle">
              <input
                type="checkbox"
                aria-label={`Enable ${p.manifest.name}`}
                checked={p.enabled}
                onChange={(e) =>
                  void store.rpc
                    .call("plugin.setEnabled", { pluginId: p.manifest.id, enabled: e.target.checked })
                    .then(plugins.refresh)
                }
              />
              enabled
            </label>
            <button
              className="mini deny"
              aria-label={`Uninstall ${p.manifest.name}`}
              onClick={() =>
                void store.rpc
                  .call("plugin.uninstall", { pluginId: p.manifest.id })
                  .then(plugins.refresh)
              }
            >
              Uninstall
            </button>
          </div>
          <div className="muted">{p.manifest.description}</div>
          <div className="muted">
            by {p.manifest.author} · {p.manifest.license}
            {p.grantedPermissions.capabilities.length > 0 &&
              ` · granted: ${p.grantedPermissions.capabilities.join(", ")}`}
          </div>
        </div>
      ))}
      {plugins.data && plugins.data.plugins.length === 0 && (
        <div className="hint">No plugins installed.</div>
      )}
    </section>
  );
}
