import { mkdir } from "node:fs/promises";
import { git, gitRaw } from "./exec.js";

export interface GitStatus {
  /** Current branch name, or null when HEAD is detached. */
  branch: string | null;
  dirty: boolean;
  /** Paths (relative to repo root) with uncommitted changes, including untracked. */
  dirtyFiles: string[];
  /** Commits ahead of upstream; 0 when no upstream. */
  ahead: number;
  /** Commits behind upstream; 0 when no upstream. */
  behind: number;
}

/** True when `path` is inside a git working tree. */
export async function isRepo(path: string): Promise<boolean> {
  try {
    const out = await git(["rev-parse", "--is-inside-work-tree"], { cwd: path });
    return out.trim() === "true";
  } catch {
    return false;
  }
}

/** Initializes a new repository at `path` (created when missing). */
export async function init(path: string, opts?: { initialBranch?: string }): Promise<void> {
  await mkdir(path, { recursive: true });
  const args = ["init"];
  if (opts?.initialBranch) {
    args.push("-b", opts.initialBranch);
  }
  await git(args, { cwd: path });
}

/** Current branch name, or null when HEAD is detached. */
export async function currentBranch(path: string): Promise<string | null> {
  const result = await gitRaw(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: path });
  if (result.code !== 0) {
    return null;
  }
  return result.stdout.trim();
}

/** Creates a branch; optionally checks it out and/or starts from a start point. */
export async function createBranch(
  path: string,
  name: string,
  opts?: { checkout?: boolean; startPoint?: string },
): Promise<void> {
  const args = opts?.checkout ? ["switch", "-c", name] : ["branch", name];
  if (opts?.startPoint) {
    args.push(opts.startPoint);
  }
  await git(args, { cwd: path });
}

/**
 * Repository status parsed from `git status --porcelain=v1 -z --branch`.
 * The -z format keeps filenames with spaces or special characters unambiguous.
 */
export async function status(path: string): Promise<GitStatus> {
  const out = await git(["status", "--porcelain=v1", "-z", "--branch", "--untracked-files=all"], {
    cwd: path,
  });
  const entries = out.split("\0");

  let branch: string | null = null;
  let ahead = 0;
  let behind = 0;

  let i = 0;
  const header = entries[0] ?? "";
  if (header.startsWith("## ")) {
    i = 1;
    const info = header.slice(3);
    const aheadMatch = /\[ahead (\d+)/.exec(info);
    const behindMatch = /behind (\d+)\]/.exec(info);
    if (aheadMatch?.[1]) ahead = Number.parseInt(aheadMatch[1], 10);
    if (behindMatch?.[1]) behind = Number.parseInt(behindMatch[1], 10);
    if (info.startsWith("HEAD (no branch)") || info.startsWith("No commits yet on ")) {
      const noCommits = /No commits yet on (.+)$/.exec(info);
      branch = noCommits?.[1] ?? null;
    } else {
      const dotdot = info.indexOf("...");
      const bracket = info.indexOf(" [");
      let end = info.length;
      if (dotdot !== -1) end = Math.min(end, dotdot);
      if (bracket !== -1) end = Math.min(end, bracket);
      branch = info.slice(0, end);
    }
  }

  const dirtyFiles: string[] = [];
  for (; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry || entry.length < 4) continue;
    const x = entry[0] ?? "";
    const y = entry[1] ?? "";
    if (x === " " && y === " ") continue;
    // With -z, renames/copies are followed by the source path as a separate entry.
    if (x === "R" || x === "C" || y === "R" || y === "C") {
      i++;
    }
    dirtyFiles.push(entry.slice(3));
  }

  return { branch, dirty: dirtyFiles.length > 0, dirtyFiles, ahead, behind };
}
