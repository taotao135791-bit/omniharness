import type { OmniDatabase } from "@omniharness/session-store";
import type { ProfileId, ProjectId, WorkspaceId } from "@omniharness/shared-types";
import type { CreateAutomationInput } from "./engine.js";

/** Seed the FK chain profile → project → workspace that automations reference. */
export function seedBase(
  db: OmniDatabase,
  at: string,
): {
  profileId: ProfileId;
  workspaceId: WorkspaceId;
} {
  const profileId = "prof_1" as ProfileId;
  const projectId = "proj_1" as ProjectId;
  const workspaceId = "ws_1" as WorkspaceId;
  db.profiles.put({ id: profileId, name: "Default", isDefault: true, createdAt: at });
  db.projects.put({ id: projectId, name: "Demo", createdAt: at });
  db.workspaces.put({
    id: workspaceId,
    projectId,
    name: "main",
    kind: "git",
    roots: ["/repo"],
    protectedPaths: [],
    readOnlyPaths: [],
    createdAt: at,
  });
  return { profileId, workspaceId };
}

export function makeInput(
  ids: { profileId: ProfileId; workspaceId: WorkspaceId },
  overrides: Partial<CreateAutomationInput> = {},
): CreateAutomationInput {
  return {
    name: "test automation",
    description: "",
    enabled: true,
    trigger: { kind: "manual" },
    profileId: ids.profileId,
    workspaceId: ids.workspaceId,
    prompt: "do the thing",
    skills: [],
    allowedTools: ["fs.read", "shell.exec"],
    networkAllowed: true,
    budget: {},
    timeoutMs: 60_000,
    output: { kind: "notification" },
    onFailure: "notify",
    maxRetries: 0,
    ...overrides,
  };
}
