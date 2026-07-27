import React, { useEffect, useMemo, useRef, useState } from "react";
import type { AppStore } from "../store.js";
import { useAppState } from "../hooks.js";
import { moveSelection, rankCommands } from "../vm/palette.js";

/** Execute a registry command against the store / daemon. */
export function executeCommand(store: AppStore, id: string): void {
  const s = store.snapshot;
  switch (id) {
    case "session.new":
      void store.createSession();
      return;
    case "session.rename":
      store.setView("chat");
      return; // rename happens inline in the sidebar
    case "session.archive":
      if (s.activeSessionId) void store.archiveSession(s.activeSessionId);
      return;
    case "agent.interrupt":
      void store.interrupt();
      return;
    case "diff.review":
      store.setView("chat");
      store.setInspectorTab("diff");
      return;
    case "diff.acceptAll":
      void store.diffDecision("accept");
      return;
    case "diff.rejectAll":
      void store.diffDecision("reject");
      return;
    case "checkpoint.create":
      void store.createCheckpoint();
      return;
    case "approval.review":
      store.setView("chat");
      store.setBottomTab("approvals");
      return;
    case "model.switch":
    case "model.bindings":
    case "provider.add":
    case "provider.test":
      store.setView("models");
      return;
    case "memory.search":
    case "memory.review":
      store.setView("memory");
      return;
    case "skill.browse":
    case "skill.proposals":
      store.setView("skills");
      return;
    case "automation.new":
    case "automation.runNow":
      store.setView("automations");
      return;
    case "plugin.manage":
      store.setView("plugins");
      return;
    case "view.sessions":
      store.setView("chat");
      return;
    case "view.diff":
      store.setView("chat");
      store.setInspectorTab("diff");
      return;
    case "view.models":
      store.setView("models");
      return;
    case "view.logs":
      store.setView("chat");
      store.setBottomTab("logs");
      return;
    case "view.settings":
      store.setView("settings");
      return;
    case "system.diagnostics":
    case "system.usage":
      store.setView("diagnostics");
      return;
    case "system.shutdown":
      void store.rpc.call("system.shutdown", { reason: "gui command palette" });
      return;
    default:
      return;
  }
}

export function CommandPalette({ store }: { store: AppStore }): React.JSX.Element | null {
  const s = useAppState(store);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const items = useMemo(
    () => rankCommands(query, s.activeSessionId !== null),
    [query, s.activeSessionId],
  );

  useEffect(() => {
    if (s.paletteOpen) {
      setQuery("");
      setIndex(0);
      inputRef.current?.focus();
    }
  }, [s.paletteOpen]);

  if (!s.paletteOpen) return null;

  const run = (i: number) => {
    const item = items[i];
    if (!item) return;
    store.setPaletteOpen(false);
    executeCommand(store, item.command.id);
  };

  return (
    <div
      className="palette-overlay"
      role="dialog"
      aria-label="Command palette"
      onClick={() => store.setPaletteOpen(false)}
    >
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          aria-label="Search commands"
          placeholder="Type a command…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") store.setPaletteOpen(false);
            else if (e.key === "ArrowDown") {
              e.preventDefault();
              setIndex((i) => moveSelection(i, 1, items.length));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIndex((i) => moveSelection(i, -1, items.length));
            } else if (e.key === "Enter") {
              e.preventDefault();
              run(index);
            }
          }}
        />
        <div className="palette-list" role="listbox" aria-label="Commands">
          {items.slice(0, 12).map((item, i) => (
            <div
              key={item.command.id}
              role="option"
              aria-selected={i === index}
              className={`palette-item ${i === index ? "active" : ""}`}
              onMouseEnter={() => setIndex(i)}
              onClick={() => run(i)}
            >
              <span className="palette-title">{item.command.title}</span>
              <span className="muted">{item.command.category}</span>
              {item.command.keybinding && <kbd>{item.command.keybinding}</kbd>}
            </div>
          ))}
          {items.length === 0 && <div className="hint">No matching commands.</div>}
        </div>
      </div>
    </div>
  );
}
