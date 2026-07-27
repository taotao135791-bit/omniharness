import React, { useEffect, useMemo } from "react";
import { createBridge } from "./bridge.js";
import { AppStore } from "./store.js";
import { useAppState } from "./hooks.js";
import { Sidebar } from "./components/Sidebar.js";
import { ChatView } from "./components/ChatView.js";
import { Inspector } from "./components/Inspector.js";
import { BottomPanel } from "./components/BottomPanel.js";
import { CommandPalette } from "./components/CommandPalette.js";
import { ModelsPage } from "./components/pages/ModelsPage.js";
import { MemoryPage } from "./components/pages/MemoryPage.js";
import { SkillsPage } from "./components/pages/SkillsPage.js";
import { AutomationsPage } from "./components/pages/AutomationsPage.js";
import { PluginsPage } from "./components/pages/PluginsPage.js";
import { SettingsPage } from "./components/pages/SettingsPage.js";
import { DiagnosticsPage } from "./components/pages/DiagnosticsPage.js";

function Shell({ store }: { store: AppStore }): React.JSX.Element {
  const s = useAppState(store);

  useEffect(() => store.start(), [store]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === "k" || e.key === "p")) {
        e.preventDefault();
        store.setPaletteOpen(!store.snapshot.paletteOpen);
      } else if (e.key === "Escape" && store.snapshot.paletteOpen) {
        store.setPaletteOpen(false);
      } else if (e.key === "Escape" && store.snapshot.chat.activeRunId) {
        void store.interrupt();
      } else if (mod && e.key === "1") {
        e.preventDefault();
        store.setView("chat");
      } else if (mod && e.key === "2") {
        e.preventDefault();
        store.setView("chat");
        store.setInspectorTab("diff");
      } else if (mod && e.key === "3") {
        e.preventDefault();
        store.setView("models");
      } else if (mod && e.key === "4") {
        e.preventDefault();
        store.setView("diagnostics");
      } else if (mod && e.key === ",") {
        e.preventDefault();
        store.setView("settings");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [store]);

  const nextTheme = s.theme === "dark" ? "light" : "dark";

  return (
    <div className="app-root" data-theme={s.theme}>
      <div className="titlebar">
        <span className="brand">OmniHarness</span>
        <button
          className="titlebar-btn"
          aria-label="Open command palette"
          onClick={() => store.setPaletteOpen(true)}
        >
          ⌘K
        </button>
        <span className="titlebar-spacer" />
        <button
          className="titlebar-btn"
          aria-label={`Switch to ${nextTheme} theme`}
          onClick={() => void store.setTheme(nextTheme)}
        >
          {s.theme === "dark" ? "☾ dark" : "☀ light"}
        </button>
        <button
          className="titlebar-btn"
          aria-label="Minimize window"
          onClick={() => void window.omni.window.minimize()}
        >
          —
        </button>
        <button
          className="titlebar-btn"
          aria-label="Maximize window"
          onClick={() => void window.omni.window.toggleMaximize()}
        >
          ▢
        </button>
      </div>

      {s.daemon !== "connected" && (
        <div className="conn-banner" role="alert">
          <span className={`dot ${s.daemon === "reconnecting" ? "reconnecting" : "disconnected"}`} />
          daemon {s.daemon}
          {s.daemon === "reconnecting" ? " — retrying…" : " — commands are unavailable"}
        </div>
      )}

      <div className="workbench">
        <Sidebar store={store} />
        <main className="center">
          {s.view === "chat" && <ChatView store={store} />}
          {s.view === "models" && <ModelsPage store={store} />}
          {s.view === "memory" && <MemoryPage store={store} />}
          {s.view === "skills" && <SkillsPage store={store} />}
          {s.view === "automations" && <AutomationsPage store={store} />}
          {s.view === "plugins" && <PluginsPage store={store} />}
          {s.view === "settings" && <SettingsPage store={store} />}
          {s.view === "diagnostics" && <DiagnosticsPage store={store} />}
          <BottomPanel store={store} />
        </main>
        {s.view === "chat" && <Inspector store={store} />}
      </div>

      <div className="statusbar">
        <span>
          <span className={`dot ${s.daemon === "connected" ? "connected" : "disconnected"}`} />
          {s.daemon}
          {s.version ? ` · v${s.version}` : ""}
        </span>
        {s.activeSessionId && (
          <span>
            session: {s.sessions.find((x) => x.id === s.activeSessionId)?.title ?? s.activeSessionId}
          </span>
        )}
        <span className="titlebar-spacer" />
        {s.approvals.filter((a) => a.status === "pending").length > 0 && (
          <span className="pending-note">
            {s.approvals.filter((a) => a.status === "pending").length} pending approval(s)
          </span>
        )}
      </div>

      <CommandPalette store={store} />
    </div>
  );
}

export function App(): React.JSX.Element {
  const store = useMemo(() => new AppStore(createBridge()), []);
  return <Shell store={store} />;
}
