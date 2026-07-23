import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkpointCommit,
  currentBranch,
  init,
  restoreCheckpoint,
  revertCommit,
  stash,
  stashPop,
  status,
  worktreeAdd,
  worktreeList,
  worktreeRemove,
} from "./index.js";
import { git } from "./exec.js";

let dir: string;

async function commitAll(repo: string, message: string): Promise<string> {
  await git(["add", "-A"], { cwd: repo });
  await git(
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", message],
    { cwd: repo },
  );
  return (await git(["rev-parse", "HEAD"], { cwd: repo })).trim();
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "omniharness-wt-"));
  await init(dir, { initialBranch: "main" });
  await writeFile(join(dir, "base.txt"), "base\n");
  await commitAll(dir, "initial");
});

afterEach(async () => {
  // Worktrees must be removed before the temp dir can be cleaned on some setups.
  try {
    for (const wt of await worktreeList(dir)) {
      if (wt.path !== dir) await worktreeRemove(dir, wt.path, { force: true });
    }
  } catch {
    // repo may already be gone
  }
  await rm(dir, { recursive: true, force: true });
});

describe("worktrees", () => {
  it("adds, lists and removes a worktree on a new branch", async () => {
    const wtPath = join(dir, "..", `${dir.split("/").pop()}-wt`);
    const info = await worktreeAdd(dir, wtPath, "feature-x");
    expect(info.branch).toBe("feature-x");

    const list = await worktreeList(dir);
    expect(list.map((w) => w.path)).toContain(wtPath);
    expect(list[0]!.path).toBe(dir);

    await writeFile(join(wtPath, "wt.txt"), "in worktree\n");
    await commitAll(wtPath, "wt commit");
    const wtStatus = await status(wtPath);
    expect(wtStatus.branch).toBe("feature-x");
    expect(wtStatus.dirty).toBe(false);

    await worktreeRemove(dir, wtPath);
    const after = await worktreeList(dir);
    expect(after.map((w) => w.path)).not.toContain(wtPath);
  });

  it("checks out an existing branch in a worktree and force-removes dirty trees", async () => {
    await git(["branch", "existing"], { cwd: dir });
    const wtPath = join(dir, "..", `${dir.split("/").pop()}-wt2`);
    const info = await worktreeAdd(dir, wtPath, "existing");
    expect(info.branch).toBe("existing");

    await writeFile(join(wtPath, "dirty.txt"), "dirty\n");
    await expect(worktreeRemove(dir, wtPath)).rejects.toThrow();
    await worktreeRemove(dir, wtPath, { force: true });
  });
});

describe("checkpoints", () => {
  it("commits the working tree to a temp ref without moving the branch", async () => {
    const before = (await git(["rev-parse", "HEAD"], { cwd: dir })).trim();
    await writeFile(join(dir, "wip.txt"), "work in progress\n");

    const cp = await checkpointCommit(dir, "wip snapshot");
    expect(cp.ref).toBe(`refs/omniharness/checkpoints/${cp.id}`);

    const after = (await git(["rev-parse", "HEAD"], { cwd: dir })).trim();
    expect(after).toBe(before);
    expect(await currentBranch(dir)).toBe("main");

    // The checkpoint commit contains the untracked file.
    const tree = await git(["show", "--name-only", "--format=", cp.commit], { cwd: dir });
    expect(tree).toContain("wip.txt");

    // User index untouched: wip.txt still untracked.
    const s = await status(dir);
    expect(s.dirtyFiles).toContain("wip.txt");
  });

  it("restores a checkpoint after stashing current changes", async () => {
    await writeFile(join(dir, "v1.txt"), "v1\n");
    const cp = await checkpointCommit(dir, "has v1");

    await writeFile(join(dir, "v2.txt"), "v2\n");
    const result = await restoreCheckpoint(dir, cp.ref);
    expect(result.stashed).toBe(true);

    // v1 restored and committed, v2 stashed away.
    expect(await readFile(join(dir, "v1.txt"), "utf8")).toBe("v1\n");
    const s = await status(dir);
    expect(s.dirty).toBe(false);
    await expect(readFile(join(dir, "v2.txt"), "utf8")).rejects.toThrow();

    // Safety stash is recoverable.
    await stashPop(dir);
    expect(await readFile(join(dir, "v2.txt"), "utf8")).toBe("v2\n");
  });

  it("stash returns false when the tree is clean", async () => {
    expect(await stash(dir)).toBe(false);
    await writeFile(join(dir, "s.txt"), "s\n");
    expect(await stash(dir, "save it")).toBe(true);
    expect((await status(dir)).dirty).toBe(false);
    await stashPop(dir);
    expect((await status(dir)).dirty).toBe(true);
  });

  it("reverts a commit with a new commit", async () => {
    await writeFile(join(dir, "r.txt"), "to be reverted\n");
    const sha = await commitAll(dir, "add r.txt");

    await revertCommit(dir, sha);
    await expect(readFile(join(dir, "r.txt"), "utf8")).rejects.toThrow();
    const log = await git(["log", "--oneline", "-1"], { cwd: dir });
    expect(log).toContain("Revert");
  });
});
