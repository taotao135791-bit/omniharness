import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createBranch,
  currentBranch,
  GitError,
  init,
  isNotARepoError,
  isRepo,
  status,
} from "./index.js";
import { git } from "./exec.js";

let dir: string;

async function commitAll(repo: string, message: string): Promise<void> {
  await git(["add", "-A"], { cwd: repo });
  await git(
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      message,
    ],
    { cwd: repo },
  );
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "omniharness-git-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("repo basics", () => {
  it("isRepo is false for a plain directory and true after init", async () => {
    expect(await isRepo(dir)).toBe(false);
    await init(dir, { initialBranch: "main" });
    expect(await isRepo(dir)).toBe(true);
  });

  it("status on a non-repo throws a GitError recognized by isNotARepoError", async () => {
    try {
      await status(dir);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(GitError);
      expect(isNotARepoError(error)).toBe(true);
    }
  });

  it("reports branch and dirty files, including names with spaces", async () => {
    await init(dir, { initialBranch: "main" });
    await writeFile(join(dir, "hello world.txt"), "hi\n");
    let s = await status(dir);
    expect(s.branch).toBe("main");
    expect(s.dirty).toBe(true);
    expect(s.dirtyFiles).toContain("hello world.txt");
    expect(s.ahead).toBe(0);
    expect(s.behind).toBe(0);

    await commitAll(dir, "initial");
    s = await status(dir);
    expect(s.dirty).toBe(false);
    expect(s.dirtyFiles).toEqual([]);

    await mkdir(join(dir, "sub dir"), { recursive: true });
    await writeFile(join(dir, "sub dir", "another file.md"), "x\n");
    s = await status(dir);
    expect(s.dirtyFiles).toContain("sub dir/another file.md");
  });

  it("tracks ahead/behind against an upstream", async () => {
    // bare "remote"
    const remote = join(dir, "remote.git");
    await mkdir(remote, { recursive: true });
    await git(["init", "--bare", "-b", "main"], { cwd: remote });

    const repo = join(dir, "repo");
    await init(repo, { initialBranch: "main" });
    await writeFile(join(repo, "a.txt"), "1\n");
    await commitAll(repo, "one");
    await git(["remote", "add", "origin", remote], { cwd: repo });
    await git(["push", "-u", "origin", "main"], { cwd: repo });

    await writeFile(join(repo, "a.txt"), "2\n");
    await commitAll(repo, "two");
    let s = await status(repo);
    expect(s.ahead).toBe(1);
    expect(s.behind).toBe(0);

    // Move the remote forward via a second clone to create "behind".
    const other = join(dir, "other");
    await git(["clone", remote, other], { cwd: dir });
    await git(["switch", "main"], { cwd: other });
    await writeFile(join(other, "b.txt"), "b\n");
    await git(["add", "-A"], { cwd: other });
    await git(
      ["-c", "user.name=T", "-c", "user.email=t@e.c", "commit", "-m", "remote"],
      { cwd: other },
    );
    await git(["push", "origin", "main"], { cwd: other });
    await git(["fetch", "origin"], { cwd: repo });

    s = await status(repo);
    expect(s.ahead).toBe(1);
    expect(s.behind).toBe(1);
  });

  it("creates branches with and without checkout", async () => {
    await init(dir, { initialBranch: "main" });
    await writeFile(join(dir, "a.txt"), "1\n");
    await commitAll(dir, "one");

    await createBranch(dir, "feature");
    expect(await currentBranch(dir)).toBe("main");

    await createBranch(dir, "topic", { checkout: true });
    expect(await currentBranch(dir)).toBe("topic");
  });
});
