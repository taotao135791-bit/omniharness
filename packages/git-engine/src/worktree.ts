import { git, gitRaw } from "./exec.js";

export interface WorktreeInfo {
  path: string;
  head: string;
  /** Branch name, or null when detached. */
  branch: string | null;
  bare: boolean;
}

/** Lists worktrees via `git worktree list --porcelain` (first entry is the main worktree). */
export async function worktreeList(repo: string): Promise<WorktreeInfo[]> {
  const out = await git(["worktree", "list", "--porcelain"], { cwd: repo });
  const result: WorktreeInfo[] = [];
  let current: { path?: string; head?: string; branch?: string | null; bare?: boolean } = {};

  const flush = (): void => {
    if (current.path !== undefined) {
      result.push({
        path: current.path,
        head: current.head ?? "",
        branch: current.branch ?? null,
        bare: current.bare ?? false,
      });
    }
    current = {};
  };

  for (const line of out.split("\n")) {
    if (line === "") {
      flush();
    } else if (line.startsWith("worktree ")) {
      current.path = line.slice("worktree ".length);
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (line === "detached") {
      current.branch = null;
    } else if (line === "bare") {
      current.bare = true;
    }
  }
  flush();
  return result;
}

export interface WorktreeAddOptions {
  /** Create the branch even if it already exists would fail; default auto-detects. */
  startPoint?: string;
}

/**
 * Adds a worktree at `path` checked out to `branch`. When the branch does not
 * exist yet it is created from `startPoint` (default HEAD).
 */
export async function worktreeAdd(
  repo: string,
  path: string,
  branch: string,
  opts?: WorktreeAddOptions,
): Promise<WorktreeInfo> {
  const exists = await gitRaw(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
    cwd: repo,
  });
  if (exists.code === 0) {
    await git(["worktree", "add", path, branch], { cwd: repo });
  } else {
    const args = ["worktree", "add", "-b", branch, path];
    if (opts?.startPoint) args.push(opts.startPoint);
    await git(args, { cwd: repo });
  }
  const worktrees = await worktreeList(repo);
  const found = worktrees.find((w) => w.path === path);
  return found ?? { path, head: "", branch, bare: false };
}

/** Removes a worktree. `force` bypasses dirty/locked safety checks. */
export async function worktreeRemove(
  repo: string,
  path: string,
  opts?: { force?: boolean },
): Promise<void> {
  const args = ["worktree", "remove"];
  if (opts?.force) args.push("--force");
  args.push(path);
  await git(args, { cwd: repo });
}
