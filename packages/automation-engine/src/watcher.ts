import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import type { Automation, AutomationId } from "@omniharness/shared-types";
import type { AutomationEngine } from "./engine.js";
import { matchGlob, staticBaseDir } from "./glob.js";

export interface FileWatcherOptions {
  /** Called once per debounced burst of matching changes. */
  onTrigger: (automation: Automation, changedPath: string) => void;
  /** Fallback debounce when the trigger doesn't set debounceMs. Default 250. */
  debounceMs?: number;
}

interface WatchEntry {
  automation: Automation;
  triggerKey: string;
  watcher: FSWatcher;
  timer: ReturnType<typeof setTimeout> | null;
  lastChangedPath: string | null;
}

const SUPPORTS_RECURSIVE = process.platform === "darwin" || process.platform === "win32";

/**
 * Watches the filesystem for automations with file_change triggers. Each
 * trigger's glob is watched at its static directory prefix (recursively where
 * the platform supports it); matching events are debounced per automation and
 * then reported via onTrigger. Call sync() after automation CRUD.
 */
export class FileWatcher {
  private readonly engine: AutomationEngine;
  private readonly options: FileWatcherOptions;
  private readonly entries = new Map<AutomationId, WatchEntry>();

  constructor(engine: AutomationEngine, options: FileWatcherOptions) {
    this.engine = engine;
    this.options = options;
  }

  start(): void {
    this.sync();
  }

  /** Reconcile watchers with the current enabled file_change automations. */
  sync(): void {
    const wanted = new Map<AutomationId, Automation>();
    for (const a of this.engine.list(true)) {
      if (a.trigger.kind === "file_change") wanted.set(a.id, a);
    }
    for (const [id, entry] of this.entries) {
      const automation = wanted.get(id);
      const key = automation === undefined ? null : triggerKey(automation);
      if (automation === undefined || key !== entry.triggerKey) {
        this.closeEntry(entry);
        this.entries.delete(id);
      }
    }
    for (const [id, automation] of wanted) {
      if (this.entries.has(id)) continue;
      const entry = this.openEntry(automation);
      if (entry !== null) this.entries.set(id, entry);
    }
  }

  stop(): void {
    for (const entry of this.entries.values()) this.closeEntry(entry);
    this.entries.clear();
  }

  private openEntry(automation: Automation): WatchEntry | null {
    if (automation.trigger.kind !== "file_change") return null;
    const glob = automation.trigger.pathGlob;
    const dir = staticBaseDir(glob);
    let watcher: FSWatcher;
    try {
      watcher = watch(dir, { recursive: SUPPORTS_RECURSIVE }, (_eventType, filename) => {
        if (filename === null) return;
        const changed = join(dir, filename.toString());
        if (!matchGlob(glob, changed)) return;
        this.debounce(automation.id, changed);
      });
    } catch {
      // Unwatchable path (missing dir, permissions): skip until next sync().
      return null;
    }
    watcher.on("error", () => {
      // Swallow watcher errors; a later sync() re-establishes the watch.
    });
    return {
      automation,
      triggerKey: triggerKey(automation),
      watcher,
      timer: null,
      lastChangedPath: null,
    };
  }

  private debounce(id: AutomationId, changedPath: string): void {
    const entry = this.entries.get(id);
    if (entry === undefined) return;
    entry.lastChangedPath = changedPath;
    if (entry.timer !== null) clearTimeout(entry.timer);
    const debounceMs =
      entry.automation.trigger.kind === "file_change"
        ? (entry.automation.trigger.debounceMs ?? this.options.debounceMs ?? 250)
        : (this.options.debounceMs ?? 250);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      this.options.onTrigger(entry.automation, entry.lastChangedPath ?? changedPath);
    }, debounceMs);
  }

  private closeEntry(entry: WatchEntry): void {
    entry.watcher.close();
    if (entry.timer !== null) clearTimeout(entry.timer);
  }
}

function triggerKey(automation: Automation): string {
  return JSON.stringify(automation.trigger);
}
