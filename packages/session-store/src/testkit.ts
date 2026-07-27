import type { ProfileId, ProjectId, SessionId, WorkspaceId } from "@omniharness/shared-types";
import { DEFAULT_CAPABILITIES } from "@omniharness/shared-types";
import type { OmniDatabase } from "../src/index.js";

/** Deterministic, incrementing ISO timestamps so ORDER BY is stable in tests. */
let clock = 0;
export function tick(): string {
  clock += 1;
  return new Date(1_700_000_000_000 + clock * 1000).toISOString();
}

export const ZERO_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
} as const;

/**
 * Seed the FK chain profile → project → workspace → session and return the ids.
 */
export function seedBase(
  db: OmniDatabase,
  suffix = "",
): {
  profileId: ProfileId;
  projectId: ProjectId;
  workspaceId: WorkspaceId;
  sessionId: SessionId;
} {
  const profileId = `prof_${suffix}1` as ProfileId;
  const projectId = `proj_${suffix}1` as ProjectId;
  const workspaceId = `ws_${suffix}1` as WorkspaceId;
  const sessionId = `sess_${suffix}1` as SessionId;

  db.profiles.put({ id: profileId, name: "Default", isDefault: true, createdAt: tick() });
  db.projects.put({ id: projectId, name: "Demo", createdAt: tick() });
  db.workspaces.put({
    id: workspaceId,
    projectId,
    name: "main",
    kind: "git",
    roots: ["/repo"],
    protectedPaths: [".env"],
    readOnlyPaths: ["vendor/**"],
    createdAt: tick(),
  });
  db.sessions.create({
    id: sessionId,
    profileId,
    projectId,
    workspaceId,
    title: `Session ${suffix}1`,
    tags: ["demo"],
    status: "active",
    headMessageId: null,
    createdAt: tick(),
    updatedAt: tick(),
    totalUsage: { ...ZERO_USAGE },
  });
  return { profileId, projectId, workspaceId, sessionId };
}

export const CAPS = DEFAULT_CAPABILITIES;
