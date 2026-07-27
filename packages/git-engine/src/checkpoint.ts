import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, gitRaw } from "./exec.js";
import { status } from "./repo.js";

export interface CheckpointAuthor {
  name: string;
  email: string;
}

const DEFAULT_AUTHOR: CheckpointAuthor = {
  name: "OmniHarness",
  email: "omniharness@localhost",
};

function authorEnv(author: CheckpointAuthor): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: author.name,
    GIT_COMMITTER_EMAIL: author.email,
  };
}

export interface CheckpointInfo {
  id: string;
  /** Full ref, e.g. refs/omniharness/checkpoints/<id>. */
  ref: string;
  commit: string;
  label: string;
}

/**
 * Commits the entire working-tree state (tracked + untracked) onto a
 * temporary ref `refs/omniharness/checkpoints/<id>` without moving the
 * current branch or touching the user's index: a throwaway index file is
 * used to build the tree.
 */
export async function checkpointCommit(
  repo: string,
  label: string,
  opts?: { author?: CheckpointAuthor },
): Promise<CheckpointInfo> {
  const id = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
  const ref = `refs/omniharness/checkpoints/${id}`;
  const env = authorEnv(opts?.author ?? DEFAULT_AUTHOR);
  const tmpIndex = join(tmpdir(), `omniharness-index-${process.pid}-${id}`);

  try {
    const indexEnv = { ...env, GIT_INDEX_FILE: tmpIndex };
    await git(["add", "-A"], { cwd: repo, env: indexEnv });
    const tree = (await git(["write-tree"], { cwd: repo, env: indexEnv })).trim();

    const head = await gitRaw(["rev-parse", "--verify", "HEAD"], { cwd: repo });
    const commitArgs = ["commit-tree", tree];
    if (head.code === 0) {
      commitArgs.push("-p", head.stdout.trim());
    }
    const commit = (await git(commitArgs, { cwd: repo, env, input: `${label}\n` })).trim();

    await git(["update-ref", ref, commit], { cwd: repo });
    return { id, ref, commit, label };
  } finally {
    await rm(tmpIndex, { force: true });
  }
}

/**
 * Resets the working tree hard to a checkpoint ref. Before resetting, any
 * uncommitted changes are pushed onto the stash as a safety net.
 */
export async function restoreCheckpoint(repo: string, ref: string): Promise<{ stashed: boolean }> {
  const current = await status(repo);
  let stashed = false;
  if (current.dirty) {
    stashed = await stash(repo, "omniharness: safety stash before checkpoint restore");
  }
  await git(["reset", "--hard", ref], { cwd: repo });
  return { stashed };
}

/**
 * Stashes uncommitted changes (including untracked files).
 * Returns false when there was nothing to stash.
 */
export async function stash(repo: string, message?: string): Promise<boolean> {
  const args = ["stash", "push", "-u"];
  if (message) args.push("-m", message);
  const out = await git(args, { cwd: repo });
  return !/No local changes to save/.test(out);
}

/** Pops the most recent stash entry. */
export async function stashPop(repo: string): Promise<void> {
  await git(["stash", "pop"], { cwd: repo });
}

/** Creates a new commit reverting `ref` (no editor). */
export async function revertCommit(
  repo: string,
  ref: string,
  opts?: { author?: CheckpointAuthor },
): Promise<void> {
  const author = opts?.author ?? DEFAULT_AUTHOR;
  await git(
    [
      "-c",
      `user.name=${author.name}`,
      "-c",
      `user.email=${author.email}`,
      "revert",
      "--no-edit",
      ref,
    ],
    { cwd: repo },
  );
}
