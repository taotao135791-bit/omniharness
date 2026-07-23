import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { Workspace } from "@omniharness/shared-types";
import { PathPolicyError } from "./errors.js";
import { IgnoreMatcher, parseGitignore } from "./ignore.js";

/**
 * Resolves symlinks for the longest existing prefix of `p`, then re-attaches
 * the not-yet-existing tail. Used to catch symlink escapes even for paths
 * that will be created by the operation.
 */
export async function realpathLoose(p: string): Promise<string> {
  const missing: string[] = [];
  let current = path.resolve(p);
  for (;;) {
    try {
      const real = await realpath(current);
      return missing.length === 0 ? real : path.join(real, ...missing.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return current;
      }
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

function isInside(real: string, realRoot: string): boolean {
  return real === realRoot || real.startsWith(realRoot + path.sep);
}

export interface ResolvedPath {
  /** Symlink-resolved absolute path. */
  real: string;
  /** Root (realpath-resolved) containing the path. */
  root: string;
  /** POSIX-style path relative to `root`. */
  rel: string;
}

/** Resolves `absPath` against the workspace roots; throws when it escapes. */
export async function resolveInWorkspace(
  workspace: Workspace,
  absPath: string,
): Promise<ResolvedPath> {
  const real = await realpathLoose(absPath);
  for (const root of workspace.roots) {
    const realRoot = await realpathLoose(root);
    if (isInside(real, realRoot)) {
      return { real, root: realRoot, rel: toPosix(path.relative(realRoot, real)) };
    }
  }
  throw new PathPolicyError(
    absPath,
    "outside-workspace",
    `Path is outside the workspace roots: ${absPath}`,
  );
}

async function matchesAny(
  patterns: readonly string[],
  rel: string,
  isDir: boolean,
): Promise<boolean> {
  if (patterns.length === 0) return false;
  const matcher = new IgnoreMatcher(parseGitignore(patterns.join("\n")));
  return matcher.isIgnored(rel, isDir);
}

async function isDirectory(real: string): Promise<boolean> {
  try {
    return (await stat(real)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Asserts the agent may write to `absPath`: it must resolve inside a
 * workspace root (after symlink resolution) and match neither
 * `protectedPaths` nor `readOnlyPaths`. Returns the resolved absolute path.
 */
export async function assertWritable(workspace: Workspace, absPath: string): Promise<string> {
  const { real, rel } = await resolveInWorkspace(workspace, absPath);
  const dir = await isDirectory(real);
  if (await matchesAny(workspace.protectedPaths, rel, dir)) {
    throw new PathPolicyError(absPath, "protected", `Path is protected: ${absPath}`);
  }
  if (await matchesAny(workspace.readOnlyPaths, rel, dir)) {
    throw new PathPolicyError(absPath, "read-only", `Path is read-only: ${absPath}`);
  }
  return real;
}

/**
 * Asserts the agent may read `absPath`. Reads outside the workspace are
 * permitted (the capability layer gates them); reads of protected paths
 * inside the workspace are denied. Returns the resolved absolute path.
 */
export async function assertReadable(workspace: Workspace, absPath: string): Promise<string> {
  const real = await realpathLoose(absPath);
  for (const root of workspace.roots) {
    const realRoot = await realpathLoose(root);
    if (isInside(real, realRoot)) {
      const rel = toPosix(path.relative(realRoot, real));
      const dir = await isDirectory(real);
      if (await matchesAny(workspace.protectedPaths, rel, dir)) {
        throw new PathPolicyError(absPath, "protected", `Path is protected: ${absPath}`);
      }
      return real;
    }
  }
  return real;
}
