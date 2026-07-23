import type { IsoTimestamp, ProjectId, WorkspaceId, WorktreeId } from "./ids.js";

export interface Profile {
  id: string;
  name: string;
  isDefault: boolean;
  createdAt: IsoTimestamp;
}

export type WorkspaceKind = "folder" | "git" | "monorepo" | "multi-root";

export interface Workspace {
  id: WorkspaceId;
  projectId: ProjectId;
  name: string;
  kind: WorkspaceKind;
  /** Absolute root paths (multi-root has more than one). */
  roots: string[];
  /** Globs the agent must never touch. */
  protectedPaths: string[];
  /** Globs that are read-only. */
  readOnlyPaths: string[];
  createdAt: IsoTimestamp;
}

export interface Project {
  id: ProjectId;
  name: string;
  createdAt: IsoTimestamp;
}

export interface Worktree {
  id: WorktreeId;
  workspaceId: WorkspaceId;
  path: string;
  branch: string;
  /** Owning agent/task; null when free. */
  ownerAgentId: string | null;
  createdAt: IsoTimestamp;
}

export type ArtifactKind = "file" | "diff" | "log" | "screenshot" | "recording" | "export";

export interface Artifact {
  id: string;
  kind: ArtifactKind;
  name: string;
  mimeType: string;
  sizeBytes: number;
  /** Storage URI (file:// or internal artifact store key). */
  uri: string;
  createdAt: IsoTimestamp;
}

export interface Checkpoint {
  id: string;
  sessionId: string;
  /** What was captured. */
  kind: "git_commit" | "fs_snapshot" | "conversation";
  ref: string;
  createdAt: IsoTimestamp;
  label: string;
}
