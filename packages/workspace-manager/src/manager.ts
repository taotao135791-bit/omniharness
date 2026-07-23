import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ProjectId, Workspace, WorkspaceId, WorkspaceKind } from "@omniharness/shared-types";
import { nowIso } from "@omniharness/shared-types";

export interface RegisterWorkspaceInput {
  name: string;
  roots: string[];
  protectedPaths?: string[];
  readOnlyPaths?: string[];
  projectId?: string;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * folder: no `.git` entry. git: `.git` present (directory or worktree file).
 * monorepo: git root that also has pnpm-workspace.yaml, lerna.json or nx.json.
 * multi-root: more than one root.
 */
export async function detectKind(roots: readonly string[]): Promise<WorkspaceKind> {
  if (roots.length > 1) return "multi-root";
  const root = roots[0];
  if (!root) return "folder";
  const isGit = await exists(join(root, ".git"));
  if (!isGit) return "folder";
  const markers = ["pnpm-workspace.yaml", "lerna.json", "nx.json"];
  for (const marker of markers) {
    if (await exists(join(root, marker))) return "monorepo";
  }
  return "git";
}

/** Registers workspaces, detects their kind, and owns their lifecycle. */
export class WorkspaceManager {
  private readonly workspaces = new Map<string, Workspace>();
  readonly dataDir: string;

  constructor(opts: { dataDir: string }) {
    this.dataDir = resolve(opts.dataDir);
  }

  async register(input: RegisterWorkspaceInput): Promise<Workspace> {
    if (input.roots.length === 0) {
      throw new Error("A workspace needs at least one root");
    }
    const roots = input.roots.map((r) => resolve(r));
    const kind = await detectKind(roots);
    const workspace: Workspace = {
      id: `ws_${randomUUID()}` as WorkspaceId,
      projectId: (input.projectId ?? `prj_${randomUUID()}`) as ProjectId,
      name: input.name,
      kind,
      roots,
      protectedPaths: input.protectedPaths ?? [],
      readOnlyPaths: input.readOnlyPaths ?? [],
      createdAt: nowIso(),
    };
    this.workspaces.set(workspace.id, workspace);
    return workspace;
  }

  get(id: string): Workspace | undefined {
    return this.workspaces.get(id);
  }

  list(): Workspace[] {
    return [...this.workspaces.values()];
  }

  remove(id: string): boolean {
    return this.workspaces.delete(id);
  }
}
