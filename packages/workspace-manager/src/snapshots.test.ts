import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createSnapshot,
  restoreSnapshot,
  walkWorkspaceFiles,
  WorkspaceManager,
} from "./index.js";
import type { Workspace } from "@omniharness/shared-types";

let dir: string;
let root: string;
let dataDir: string;
let ws: Workspace;

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "omniharness-snap-"));
  root = join(dir, "root");
  dataDir = join(dir, "data");
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "node_modules", "dep"), { recursive: true });
  await writeFile(join(root, "src", "a.ts"), "aaa\n");
  await writeFile(join(root, "src", "b.ts"), "bbb\n");
  await writeFile(join(root, "node_modules", "dep", "index.js"), "ignored\n");
  await writeFile(join(root, ".gitignore"), "dist/\n");

  const mgr = new WorkspaceManager({ dataDir });
  ws = await mgr.register({ name: "snap", roots: [root] });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("snapshots", () => {
  it("walks files while skipping node_modules, .git and ignored paths", async () => {
    await mkdir(join(root, "dist"), { recursive: true });
    await writeFile(join(root, "dist", "bundle.js"), "built\n");
    await mkdir(join(root, ".git"), { recursive: true });
    await writeFile(join(root, ".git", "HEAD"), "ref\n");

    const files = await walkWorkspaceFiles(ws);
    const rels = files.map((f) => f.rel).sort();
    expect(rels).toEqual([".gitignore", "src/a.ts", "src/b.ts"]);
  });

  it("round-trips added, modified and deleted files", async () => {
    const snap = await createSnapshot(ws, dataDir, { label: "v1" });
    expect(snap.fileCount).toBe(3); // .gitignore, src/a.ts, src/b.ts

    // Mutate: modify a.ts, delete b.ts, add c.ts and a new dir with d.ts.
    await writeFile(join(root, "src", "a.ts"), "MODIFIED\n");
    await rm(join(root, "src", "b.ts"));
    await writeFile(join(root, "c.ts"), "added after snapshot\n");
    await mkdir(join(root, "newdir"), { recursive: true });
    await writeFile(join(root, "newdir", "d.ts"), "new\n");

    const result = await restoreSnapshot(ws, dataDir, snap.id);
    expect(result.deleted).toBeGreaterThanOrEqual(2); // c.ts, newdir/d.ts
    expect(result.restored).toBe(2); // a.ts modified, b.ts missing

    expect(await readFile(join(root, "src", "a.ts"), "utf8")).toBe("aaa\n");
    expect(await readFile(join(root, "src", "b.ts"), "utf8")).toBe("bbb\n");
    expect(await pathExists(join(root, "c.ts"))).toBe(false);
    // Empty directory left by deleted files is pruned.
    expect(await pathExists(join(root, "newdir"))).toBe(false);
    // Untouched but walked-around dirs stay.
    expect(await pathExists(join(root, "node_modules", "dep", "index.js"))).toBe(true);
  });

  it("is a no-op when nothing changed", async () => {
    const snap = await createSnapshot(ws, dataDir);
    const result = await restoreSnapshot(ws, dataDir, snap.id);
    expect(result.restored).toBe(0);
    expect(result.deleted).toBe(0);
  });

  it("records but does not store files over the size cap", async () => {
    await writeFile(join(root, "big.bin"), Buffer.alloc(2048, 7));
    const snap = await createSnapshot(ws, dataDir, { maxFileSizeBytes: 1024 });
    expect(snap.skippedFiles).toContain("big.bin");

    await writeFile(join(root, "big.bin"), Buffer.alloc(2048, 9));
    const result = await restoreSnapshot(ws, dataDir, snap.id);
    expect(result.skipped).toContain("big.bin");
    // Over-cap file is left alone.
    expect((await readFile(join(root, "big.bin")))[0]).toBe(9);
  });
});
