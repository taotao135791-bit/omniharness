import React, { useState } from "react";
import type { AppStore, MainView } from "../store.js";
import { useAppState } from "../hooks.js";

const NAV: Array<{ view: MainView; label: string; key: string }> = [
  { view: "chat", label: "Command Center", key: "1" },
  { view: "models", label: "Models", key: "3" },
  { view: "memory", label: "Memory", key: "" },
  { view: "skills", label: "Skills", key: "" },
  { view: "automations", label: "Automations", key: "" },
  { view: "plugins", label: "Plugins", key: "" },
  { view: "settings", label: "Settings", key: "," },
  { view: "diagnostics", label: "Diagnostics", key: "4" },
];

export function Sidebar({ store }: { store: AppStore }): React.JSX.Element {
  const s = useAppState(store);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");
  const [addingProfile, setAddingProfile] = useState(false);
  const [addingProject, setAddingProject] = useState(false);
  const [addingWorkspace, setAddingWorkspace] = useState(false);
  const [newName, setNewName] = useState("");

  const projectSessions = s.sessions.filter(
    (x) => !s.activeProjectId || x.projectId === s.activeProjectId,
  );

  const submitNew = async (kind: "profile" | "project" | "workspace") => {
    const name = newName.trim();
    if (!name) return;
    setNewName("");
    setAddingProfile(false);
    setAddingProject(false);
    setAddingWorkspace(false);
    if (kind === "profile") await store.createProfile(name);
    else if (kind === "project") await store.createProject(name);
    else await store.registerWorkspace(name);
  };

  return (
    <aside className="sidebar" aria-label="Sidebar">
      <div className="side-section">
        <div className="side-head">
          <h2>Profile</h2>
          <button
            className="icon-btn"
            aria-label="Add profile"
            onClick={() => {
              setAddingProfile((v) => !v);
              setNewName("");
            }}
          >
            +
          </button>
        </div>
        <select
          aria-label="Active profile"
          value={s.activeProfileId ?? ""}
          onChange={(e) => void store.selectProfile(e.target.value)}
        >
          {s.profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
          {s.profiles.length === 0 && <option value="">—</option>}
        </select>
        {addingProfile && (
          <input
            autoFocus
            aria-label="New profile name"
            placeholder="Profile name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submitNew("profile");
              if (e.key === "Escape") setAddingProfile(false);
            }}
          />
        )}
      </div>

      <div className="side-section">
        <div className="side-head">
          <h2>Projects</h2>
          <button
            className="icon-btn"
            aria-label="Add project"
            onClick={() => {
              setAddingProject((v) => !v);
              setNewName("");
            }}
          >
            +
          </button>
        </div>
        {s.projects.map((p) => (
          <button
            key={p.id}
            className={`row-item ${p.id === s.activeProjectId ? "active" : ""}`}
            onClick={() => void store.selectProject(p.id)}
          >
            {p.name}
          </button>
        ))}
        {addingProject && (
          <input
            autoFocus
            aria-label="New project name"
            placeholder="Project name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submitNew("project");
              if (e.key === "Escape") setAddingProject(false);
            }}
          />
        )}
        {s.activeProjectId && (
          <div className="workspaces">
            {s.workspaces.map((w) => (
              <div key={w.id} className="ws-item" title={w.roots.join(", ")}>
                ⌂ {w.name}
              </div>
            ))}
            {s.workspaces.length === 0 && !addingWorkspace && (
              <div className="hint">No workspace registered.</div>
            )}
            {addingWorkspace ? (
              <input
                autoFocus
                aria-label="Workspace path"
                placeholder="/absolute/path"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submitNew("workspace");
                  if (e.key === "Escape") setAddingWorkspace(false);
                }}
              />
            ) : (
              <button
                className="link-btn"
                onClick={() => {
                  setAddingWorkspace(true);
                  setNewName("");
                }}
              >
                + workspace path
              </button>
            )}
          </div>
        )}
      </div>

      <div className="side-section grow">
        <div className="side-head">
          <h2>Sessions</h2>
          <button
            className="icon-btn"
            aria-label="New session"
            disabled={s.workspaces.length === 0}
            title={s.workspaces.length === 0 ? "Register a workspace first" : "New session"}
            onClick={() => void store.createSession()}
          >
            +
          </button>
        </div>
        <div className="session-list" role="listbox" aria-label="Sessions">
          {projectSessions.map((sess) =>
            renaming === sess.id ? (
              <input
                key={sess.id}
                autoFocus
                aria-label="Rename session"
                value={renameText}
                onChange={(e) => setRenameText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    setRenaming(null);
                    void store.renameSession(sess.id, renameText.trim() || sess.title);
                  }
                  if (e.key === "Escape") setRenaming(null);
                }}
                onBlur={() => setRenaming(null)}
              />
            ) : (
              <div
                key={sess.id}
                role="option"
                aria-selected={sess.id === s.activeSessionId}
                tabIndex={0}
                className={`session-item ${sess.id === s.activeSessionId ? "active" : ""}`}
                onClick={() => void store.selectSession(sess.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") void store.selectSession(sess.id);
                }}
              >
                <span className="session-title">{sess.title || sess.id}</span>
                <span className="session-actions">
                  <button
                    className="icon-btn"
                    aria-label={`Rename ${sess.title}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setRenaming(sess.id);
                      setRenameText(sess.title);
                    }}
                  >
                    ✎
                  </button>
                  <button
                    className="icon-btn"
                    aria-label={`Archive ${sess.title}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      void store.archiveSession(sess.id);
                    }}
                  >
                    ⤓
                  </button>
                </span>
              </div>
            ),
          )}
          {projectSessions.length === 0 && <div className="hint">No sessions yet.</div>}
        </div>
      </div>

      {s.agents.length > 0 && (
        <div className="side-section">
          <div className="side-head">
            <h2>Agents</h2>
          </div>
          {s.agents.map((a) => (
            <div key={a.id} className="agent-item">
              <span className={`badge status-${a.status}`}>{a.status}</span> {a.displayName}
              <span className="muted"> · {a.kind}</span>
            </div>
          ))}
        </div>
      )}

      <nav className="side-nav" aria-label="Pages">
        {NAV.map((n) => (
          <button
            key={n.view}
            className={`nav-item ${s.view === n.view ? "active" : ""}`}
            onClick={() => store.setView(n.view)}
          >
            {n.label}
            {n.key && <kbd>⌃{n.key}</kbd>}
          </button>
        ))}
      </nav>
    </aside>
  );
}
