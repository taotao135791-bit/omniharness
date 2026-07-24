import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type OmniDatabase } from "@omniharness/session-store";
import type { ProfileId, WorkspaceId } from "@omniharness/shared-types";
import { AutomationEngine } from "./engine.js";
import { FileWatcher } from "./watcher.js";
import { makeInput, seedBase } from "./testkit.js";

let db: OmniDatabase;
let engine: AutomationEngine;
let ids: { profileId: ProfileId; workspaceId: WorkspaceId };
let dir: string;
let watcher: FileWatcher | null = null;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  db = openDatabase(":memory:");
  ids = seedBase(db, new Date().toISOString());
  engine = new AutomationEngine({ repo: db.automations });
  dir = mkdtempSync(join(tmpdir(), "omni-watch-"));
});

afterEach(() => {
  watcher?.stop();
  watcher = null;
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("FileWatcher", () => {
  it("fires once after a debounced burst of matching changes", async () => {
    const a = engine.create(
      makeInput(ids, { trigger: { kind: "file_change", pathGlob: join(dir, "**", "*.md") } }),
    );
    const fired: string[] = [];
    watcher = new FileWatcher(engine, {
      debounceMs: 60,
      onTrigger: (automation, changedPath) => {
        expect(automation.id).toBe(a.id);
        fired.push(changedPath);
      },
    });
    watcher.start();

    writeFileSync(join(dir, "a.md"), "one");
    await sleep(20);
    writeFileSync(join(dir, "a.md"), "two");
    await sleep(20);
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(join(dir, "sub", "b.md"), "three");

    await sleep(400);
    expect(fired.length).toBe(1); // burst coalesced by debounce
  });

  it("ignores non-matching paths and disabled automations", async () => {
    const on = engine.create(
      makeInput(ids, { trigger: { kind: "file_change", pathGlob: join(dir, "*.md") } }),
    );
    const off = engine.create(
      makeInput(ids, {
        enabled: false,
        trigger: { kind: "file_change", pathGlob: join(dir, "*.txt") },
      }),
    );
    const fired: string[] = [];
    watcher = new FileWatcher(engine, {
      debounceMs: 60,
      onTrigger: (automation) => fired.push(automation.id),
    });
    watcher.start();

    writeFileSync(join(dir, "notes.txt"), "matches only the disabled automation");
    await sleep(300);
    expect(fired).toHaveLength(0);

    writeFileSync(join(dir, "notes.md"), "matches the enabled automation");
    await sleep(400);
    expect(fired).toEqual([on.id]);
    void off;
  });

  it("picks up new automations on sync()", async () => {
    const fired: string[] = [];
    watcher = new FileWatcher(engine, {
      debounceMs: 60,
      onTrigger: (automation) => fired.push(automation.id),
    });
    watcher.start();

    writeFileSync(join(dir, "early.md"), "before automation existed");
    await sleep(200);
    expect(fired).toHaveLength(0);

    const a = engine.create(
      makeInput(ids, { trigger: { kind: "file_change", pathGlob: join(dir, "*.md") } }),
    );
    watcher.sync();
    writeFileSync(join(dir, "late.md"), "after sync");
    await sleep(400);
    expect(fired).toEqual([a.id]);
  });
});
