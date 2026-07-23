import type { DatabaseSync } from "node:sqlite";
import type {
  Profile,
  Project,
  ProjectId,
  Workspace,
  WorkspaceId,
  Worktree,
} from "@omniharness/shared-types";
import { allRows, bit, bool, getRow, jparse, jstr } from "../helpers.js";

interface ProfileRow {
  id: string;
  name: string;
  is_default: number;
  created_at: string;
}

function rowToProfile(r: ProfileRow): Profile {
  return { id: r.id, name: r.name, isDefault: bool(r.is_default), createdAt: r.created_at };
}

export class ProfilesRepo {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  put(profile: Profile): void {
    this.db
      .prepare(
        `INSERT INTO profiles (id, name, is_default, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, is_default = excluded.is_default`,
      )
      .run(profile.id, profile.name, bit(profile.isDefault), profile.createdAt);
  }

  get(id: string): Profile | undefined {
    const row = getRow<ProfileRow>(this.db.prepare("SELECT * FROM profiles WHERE id = ?"), id);
    return row === undefined ? undefined : rowToProfile(row);
  }

  getDefault(): Profile | undefined {
    const row = getRow<ProfileRow>(
      this.db.prepare("SELECT * FROM profiles WHERE is_default = 1 LIMIT 1"),
    );
    return row === undefined ? undefined : rowToProfile(row);
  }

  list(): Profile[] {
    return allRows<ProfileRow>(this.db.prepare("SELECT * FROM profiles ORDER BY created_at")).map(
      rowToProfile,
    );
  }

  delete(id: string): boolean {
    return this.db.prepare("DELETE FROM profiles WHERE id = ?").run(id).changes > 0;
  }
}

interface ProjectRow {
  id: string;
  name: string;
  created_at: string;
}

export class ProjectsRepo {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  put(project: Project): void {
    this.db
      .prepare(
        `INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name`,
      )
      .run(project.id, project.name, project.createdAt);
  }

  get(id: ProjectId): Project | undefined {
    const row = getRow<ProjectRow>(this.db.prepare("SELECT * FROM projects WHERE id = ?"), id);
    if (row === undefined) return undefined;
    return { id: row.id as ProjectId, name: row.name, createdAt: row.created_at };
  }

  list(): Project[] {
    return allRows<ProjectRow>(this.db.prepare("SELECT * FROM projects ORDER BY created_at")).map(
      (r) => ({ id: r.id as ProjectId, name: r.name, createdAt: r.created_at }),
    );
  }

  delete(id: ProjectId): boolean {
    return this.db.prepare("DELETE FROM projects WHERE id = ?").run(id).changes > 0;
  }
}

interface WorkspaceRow {
  id: string;
  project_id: string;
  name: string;
  kind: string;
  roots: string;
  protected_paths: string;
  read_only_paths: string;
  created_at: string;
}

function rowToWorkspace(r: WorkspaceRow): Workspace {
  return {
    id: r.id as Workspace["id"],
    projectId: r.project_id as Workspace["projectId"],
    name: r.name,
    kind: r.kind as Workspace["kind"],
    roots: jparse<string[]>(r.roots, []),
    protectedPaths: jparse<string[]>(r.protected_paths, []),
    readOnlyPaths: jparse<string[]>(r.read_only_paths, []),
    createdAt: r.created_at,
  };
}

export class WorkspacesRepo {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  put(workspace: Workspace): void {
    this.db
      .prepare(
        `INSERT INTO workspaces (id, project_id, name, kind, roots, protected_paths, read_only_paths, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, kind = excluded.kind, roots = excluded.roots,
           protected_paths = excluded.protected_paths, read_only_paths = excluded.read_only_paths`,
      )
      .run(
        workspace.id,
        workspace.projectId,
        workspace.name,
        workspace.kind,
        jstr(workspace.roots),
        jstr(workspace.protectedPaths),
        jstr(workspace.readOnlyPaths),
        workspace.createdAt,
      );
  }

  get(id: WorkspaceId): Workspace | undefined {
    const row = getRow<WorkspaceRow>(this.db.prepare("SELECT * FROM workspaces WHERE id = ?"), id);
    return row === undefined ? undefined : rowToWorkspace(row);
  }

  listByProject(projectId: ProjectId): Workspace[] {
    return allRows<WorkspaceRow>(
      this.db.prepare("SELECT * FROM workspaces WHERE project_id = ? ORDER BY created_at"),
      projectId,
    ).map(rowToWorkspace);
  }

  delete(id: WorkspaceId): boolean {
    return this.db.prepare("DELETE FROM workspaces WHERE id = ?").run(id).changes > 0;
  }
}

interface WorktreeRow {
  id: string;
  workspace_id: string;
  path: string;
  branch: string;
  owner_agent_id: string | null;
  created_at: string;
}

function rowToWorktree(r: WorktreeRow): Worktree {
  return {
    id: r.id as Worktree["id"],
    workspaceId: r.workspace_id as Worktree["workspaceId"],
    path: r.path,
    branch: r.branch,
    ownerAgentId: r.owner_agent_id,
    createdAt: r.created_at,
  };
}

export class WorktreesRepo {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  put(worktree: Worktree): void {
    this.db
      .prepare(
        `INSERT INTO worktrees (id, workspace_id, path, branch, owner_agent_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           path = excluded.path, branch = excluded.branch, owner_agent_id = excluded.owner_agent_id`,
      )
      .run(
        worktree.id,
        worktree.workspaceId,
        worktree.path,
        worktree.branch,
        worktree.ownerAgentId,
        worktree.createdAt,
      );
  }

  get(id: Worktree["id"]): Worktree | undefined {
    const row = getRow<WorktreeRow>(this.db.prepare("SELECT * FROM worktrees WHERE id = ?"), id);
    return row === undefined ? undefined : rowToWorktree(row);
  }

  listByWorkspace(workspaceId: WorkspaceId): Worktree[] {
    return allRows<WorktreeRow>(
      this.db.prepare("SELECT * FROM worktrees WHERE workspace_id = ? ORDER BY created_at"),
      workspaceId,
    ).map(rowToWorktree);
  }

  /** Claim a free worktree for an agent (or release with null). */
  setOwner(id: Worktree["id"], ownerAgentId: string | null): boolean {
    return (
      this.db.prepare("UPDATE worktrees SET owner_agent_id = ? WHERE id = ?").run(ownerAgentId, id)
        .changes > 0
    );
  }

  delete(id: Worktree["id"]): boolean {
    return this.db.prepare("DELETE FROM worktrees WHERE id = ?").run(id).changes > 0;
  }
}
