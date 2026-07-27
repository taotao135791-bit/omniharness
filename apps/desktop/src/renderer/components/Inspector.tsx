import React, { useState } from "react";
import type { AppStore, InspectorTab } from "../store.js";
import { useAppState, useQuery } from "../hooks.js";
import { fileDecision, hunksOf, statusBadge, summarizeDiff } from "../vm/diff.js";
import { toUsageBars } from "../vm/usage.js";
import { formatTokens } from "../vm/chat.js";
import type { DiffFile } from "@omniharness/agent-protocol";
import type { ModelRole } from "@omniharness/shared-types";

const TABS: Array<{ id: InspectorTab; label: string }> = [
  { id: "diff", label: "Diff" },
  { id: "files", label: "Files" },
  { id: "artifacts", label: "Artifacts" },
  { id: "context", label: "Context" },
  { id: "usage", label: "Usage" },
];

function FileDiff({ store, file }: { store: AppStore; file: DiffFile }): React.JSX.Element {
  const [open, setOpen] = useState(true);
  const decision = fileDecision(file);
  return (
    <div className="diff-file">
      <div className="diff-file-head">
        <button
          className="diff-file-toggle"
          aria-expanded={open}
          aria-label={`Toggle ${file.path}`}
          onClick={() => setOpen((v) => !v)}
        >
          <span className={`chev ${open ? "open" : ""}`}>▸</span>
          <span className={`badge file-${file.status}`}>{statusBadge(file.status)}</span>
          <span className="diff-path">{file.path}</span>
          <span className="diff-stats">
            <span className="add">+{file.additions}</span>{" "}
            <span className="del">−{file.deletions}</span>
          </span>
          <span className={`badge decision-${decision}`}>{decision}</span>
        </button>
        <span className="diff-file-actions">
          <button
            className="mini"
            aria-label={`Accept all hunks in ${file.path}`}
            onClick={() => void store.diffDecision("accept", file.path)}
          >
            accept
          </button>
          <button
            className="mini"
            aria-label={`Reject all hunks in ${file.path}`}
            onClick={() => void store.diffDecision("reject", file.path)}
          >
            reject
          </button>
        </span>
      </div>
      {open &&
        hunksOf(file).map((h) => (
          <div key={h.index} className="hunk">
            <div className="hunk-head">
              <code>{h.header}</code>
              <span className="hunk-actions">
                <button
                  className="mini approve"
                  disabled={h.accepted === true}
                  aria-label={`Accept hunk ${h.index} in ${file.path}`}
                  onClick={() => void store.diffDecision("accept", file.path, h.index)}
                >
                  ✓
                </button>
                <button
                  className="mini deny"
                  disabled={h.accepted === false}
                  aria-label={`Reject hunk ${h.index} in ${file.path}`}
                  onClick={() => void store.diffDecision("reject", file.path, h.index)}
                >
                  ✗
                </button>
              </span>
            </div>
            <pre className="hunk-body">
              {h.lines.map((l, i) => (
                <div key={i} className={`diff-line ${l.kind}`}>
                  <span className="diff-sign">
                    {l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}
                  </span>
                  {l.text}
                </div>
              ))}
            </pre>
          </div>
        ))}
    </div>
  );
}

function DiffTab({ store }: { store: AppStore }): React.JSX.Element {
  const s = useAppState(store);
  const summary = summarizeDiff(s.diff);
  return (
    <div className="inspector-body">
      <div className="inspector-toolbar">
        <span className="muted">
          {summary.files} files · <span className="add">+{summary.additions}</span>{" "}
          <span className="del">−{summary.deletions}</span> · {summary.decidedHunks}/
          {summary.totalHunks} hunks decided
        </span>
        <button onClick={() => void store.refreshDiff()} aria-label="Refresh diff">
          ⟳
        </button>
        <button
          disabled={!s.diff || s.diff.files.length === 0}
          onClick={() => void store.diffDecision("accept")}
        >
          Accept all
        </button>
        <button
          disabled={!s.diff || s.diff.files.length === 0}
          onClick={() => void store.diffDecision("reject")}
        >
          Reject all
        </button>
        <button
          disabled={!s.activeSessionId}
          onClick={() => void store.createCheckpoint()}
          aria-label="Create checkpoint"
        >
          Checkpoint
        </button>
      </div>
      {s.checkpoints.length > 0 && (
        <div className="checkpoints">
          {s.checkpoints.map((c) => (
            <span key={c.id} className="checkpoint">
              {c.label || c.kind} · {new Date(c.createdAt).toLocaleTimeString()}
              <button
                className="mini"
                aria-label={`Restore checkpoint ${c.label || c.id}`}
                onClick={() => void store.restoreCheckpoint(c.id)}
              >
                restore
              </button>
            </span>
          ))}
        </div>
      )}
      {!s.activeSessionId && <div className="hint">Select a session to review its diff.</div>}
      {s.activeSessionId && s.diff && s.diff.files.length === 0 && (
        <div className="hint">Working tree clean — no changes.</div>
      )}
      {(s.diff?.files ?? []).map((f) => (
        <FileDiff key={f.path} store={store} file={f} />
      ))}
      {s.diff?.truncated && <div className="hint">Diff truncated by the daemon.</div>}
    </div>
  );
}

function FilesTab({ store }: { store: AppStore }): React.JSX.Element {
  const s = useAppState(store);
  return (
    <div className="inspector-body">
      <div className="inspector-toolbar">
        <span className="muted">
          {s.dirtyFiles
            ? `${s.dirtyFiles.files.length} dirty files${s.dirtyFiles.branch ? ` on ${s.dirtyFiles.branch}` : ""}`
            : "No workspace status"}
        </span>
        <button onClick={() => void store.refreshDirtyFiles()} aria-label="Refresh file status">
          ⟳
        </button>
      </div>
      {(s.dirtyFiles?.files ?? []).map((f) => (
        <div key={f} className="file-row">
          {f}
        </div>
      ))}
      {s.dirtyFiles && s.dirtyFiles.files.length === 0 && (
        <div className="hint">Working tree clean.</div>
      )}
    </div>
  );
}

function ArtifactsTab({ store }: { store: AppStore }): React.JSX.Element {
  const s = useAppState(store);
  return (
    <div className="inspector-body">
      <div className="inspector-toolbar">
        <span className="muted">{s.artifacts.length} artifacts</span>
        <button onClick={() => void store.refreshArtifacts()} aria-label="Refresh artifacts">
          ⟳
        </button>
      </div>
      {s.artifacts.map((a) => (
        <div key={a.id} className="file-row" title={a.uri}>
          <span className={`badge kind-${a.kind}`}>{a.kind}</span> {a.name}
          <span className="muted"> {(a.sizeBytes / 1024).toFixed(1)} KB</span>
        </div>
      ))}
      {s.artifacts.length === 0 && <div className="hint">No artifacts yet.</div>}
    </div>
  );
}

function ContextTab({ store }: { store: AppStore }): React.JSX.Element {
  const s = useAppState(store);
  const session = s.sessions.find((x) => x.id === s.activeSessionId);
  const bindings = useQuery(
    store,
    () =>
      s.activeSessionId
        ? store.rpc.call("model.getRoleBindings", { sessionId: s.activeSessionId })
        : Promise.resolve<{ bindings: Partial<Record<ModelRole, string>> }>({ bindings: {} }),
    [s.activeSessionId],
    true,
  );
  if (!session) return <div className="inspector-body hint">No session selected.</div>;
  const bound = Object.entries(bindings.data?.bindings ?? {});
  return (
    <div className="inspector-body context-tab">
      <dl>
        <dt>Title</dt>
        <dd>{session.title}</dd>
        <dt>Model override</dt>
        <dd>{session.modelId ?? "—"}</dd>
        <dt>Tags</dt>
        <dd>{session.tags.length > 0 ? session.tags.join(", ") : "—"}</dd>
        <dt>Session usage</dt>
        <dd>
          {formatTokens(session.totalUsage.inputTokens)} in ·{" "}
          {formatTokens(session.totalUsage.outputTokens)} out
          {session.totalUsage.costUsd !== undefined &&
            ` · $${session.totalUsage.costUsd.toFixed(4)}`}
        </dd>
        <dt>Updated</dt>
        <dd>{new Date(session.updatedAt).toLocaleString()}</dd>
        <dt>Role bindings</dt>
        <dd>
          {bound.length === 0
            ? "—"
            : bound.map(([role, model]) => (
                <div key={role}>
                  <span className="muted">{role}:</span> {model}
                </div>
              ))}
        </dd>
      </dl>
    </div>
  );
}

function UsageTab({ store }: { store: AppStore }): React.JSX.Element {
  const usage = useQuery(
    store,
    () => store.rpc.call("usage.summary", { groupBy: "model" }),
    [],
    true,
  );
  const bars = toUsageBars(usage.data?.usage ?? []);
  return (
    <div className="inspector-body">
      <div className="inspector-toolbar">
        <span className="muted">usage by model</span>
        <button onClick={usage.refresh} aria-label="Refresh usage">
          ⟳
        </button>
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
            {formatTokens(b.totalTokens)}
            {b.costUsd !== null && ` · $${b.costUsd.toFixed(3)}`}
          </div>
        </div>
      ))}
      {bars.length === 0 && !usage.loading && <div className="hint">No usage recorded yet.</div>}
    </div>
  );
}

export function Inspector({ store }: { store: AppStore }): React.JSX.Element {
  const s = useAppState(store);
  return (
    <aside className="inspector" aria-label="Inspector">
      <div className="tab-bar" role="tablist" aria-label="Inspector tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={s.inspectorTab === t.id}
            className={`tab ${s.inspectorTab === t.id ? "active" : ""}`}
            onClick={() => store.setInspectorTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {s.inspectorTab === "diff" && <DiffTab store={store} />}
      {s.inspectorTab === "files" && <FilesTab store={store} />}
      {s.inspectorTab === "artifacts" && <ArtifactsTab store={store} />}
      {s.inspectorTab === "context" && <ContextTab store={store} />}
      {s.inspectorTab === "usage" && <UsageTab store={store} />}
    </aside>
  );
}
