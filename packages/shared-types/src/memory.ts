import type { IsoTimestamp, MemoryId, ProfileId, ProjectId, SessionId } from "./ids.js";

export type MemoryKind =
  "working" | "session" | "episodic" | "semantic" | "userPreference" | "project" | "procedural";

export type Sensitivity = "normal" | "sensitive" | "secret-adjacent";

export interface MemoryEntry {
  id: MemoryId;
  kind: MemoryKind;
  profileId: ProfileId;
  /** Null = applies to all projects of the profile. */
  projectId: ProjectId | null;
  content: string;
  /** Searchable summary for FTS. */
  summary: string;
  /** Session this memory was derived from. */
  sourceSessionId: SessionId | null;
  createdBy: "user" | "agent" | "import";
  createdAt: IsoTimestamp;
  lastVerifiedAt: IsoTimestamp;
  /** 0..1; agent-proposed memories start below 1. */
  confidence: number;
  /** Profiles/projects this memory is allowed to surface in. */
  scope: { profileId: ProfileId; projectId: ProjectId | null };
  approvedByUser: boolean;
  /** Message/event references backing this memory. */
  evidenceRefs: string[];
  sensitivity: Sensitivity;
  expiresAt: IsoTimestamp | null;
  archived: boolean;
}

export interface MemoryQuery {
  text: string;
  kinds?: MemoryKind[];
  profileId: ProfileId;
  projectId?: ProjectId | undefined;
  limit?: number;
  /** Only return user-approved or user-created memories. */
  approvedOnly?: boolean;
  /** Include unapproved agent proposals. */
  includePending?: boolean;
}

export interface MemorySearchResult {
  entry: MemoryEntry;
  score: number;
}
