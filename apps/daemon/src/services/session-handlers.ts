import { nanoid } from "./id.js";
import type {
  Profile,
  Project,
  Session,
  SessionId,
  Workspace,
} from "@omniharness/shared-types";
import { nowIso } from "@omniharness/shared-types";
import type { OmniDatabase } from "@omniharness/session-store";
import type { EventBus } from "../event-bus.js";
import { RpcError } from "../rpc-server.js";
import { ErrorCodes } from "@omniharness/agent-protocol";

/** Profile/project/workspace/session command handlers (pure CRUD + events). */
export function registerSessionHandlers(
  register: (name: string, handler: (params: never) => unknown) => void,
  db: OmniDatabase,
  bus: EventBus,
): void {
  const defaultProfile = (): Profile => {
    let profile = db.profiles.getDefault();
    if (!profile) {
      profile = { id: nanoid("prof") as Profile["id"], name: "default", isDefault: true, createdAt: nowIso() };
      db.profiles.put(profile);
    }
    return profile;
  };

  register("profile.list", () => ({ profiles: db.profiles.list() }));

  register("profile.create", (params: { name: string }) => {
    const profile: Profile = { id: nanoid("prof") as Profile["id"], name: params.name, isDefault: false, createdAt: nowIso() };
    db.profiles.put(profile);
    return { profile };
  });

  register("project.list", () => ({ projects: db.projects.list() }));

  register("project.create", (params: { name: string }) => {
    const project: Project = { id: nanoid("proj") as Project["id"], name: params.name, createdAt: nowIso() };
    db.projects.put(project);
    return { project };
  });

  register("workspace.register", (params: { projectId: string; roots: string[]; name?: string }) => {
    const project = db.projects.get(params.projectId as Project["id"]);
    if (!project) throw new RpcError(ErrorCodes.NOT_FOUND, `project not found: ${params.projectId}`);
    const workspace: Workspace = {
      id: nanoid("ws") as Workspace["id"],
      projectId: project.id,
      name: params.name ?? params.roots[0]?.split("/").pop() ?? "workspace",
      kind: params.roots.length > 1 ? "multi-root" : "folder",
      roots: params.roots,
      protectedPaths: [],
      readOnlyPaths: [],
      createdAt: nowIso(),
    };
    db.workspaces.put(workspace);
    return { workspace };
  });

  register("workspace.list", (params: { projectId?: string }) => ({
    workspaces: params.projectId
      ? db.workspaces.listByProject(params.projectId as Project["id"])
      : db.projects.list().flatMap((p) => db.workspaces.listByProject(p.id)),
  }));

  register("session.create", (params: { workspaceId: string; title?: string; profileId?: string }) => {
    const workspace = db.workspaces.get(params.workspaceId as Workspace["id"]);
    if (!workspace) throw new RpcError(ErrorCodes.NOT_FOUND, `workspace not found: ${params.workspaceId}`);
    const profile = params.profileId
      ? db.profiles.get(params.profileId)
      : defaultProfile();
    if (!profile) throw new RpcError(ErrorCodes.NOT_FOUND, "profile not found");
    const session: Session = {
      id: nanoid("sess") as SessionId,
      profileId: profile.id as Session["profileId"],
      projectId: workspace.projectId,
      workspaceId: workspace.id,
      title: params.title ?? "New session",
      tags: [],
      status: "active",
      headMessageId: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      totalUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
    db.sessions.create(session);
    bus.emit({ type: "session.created", sessionId: session.id, title: session.title });
    return { session };
  });

  register("session.get", (params: { sessionId: SessionId }) => {
    const session = db.sessions.get(params.sessionId);
    if (!session) throw new RpcError(ErrorCodes.NOT_FOUND, `session not found: ${params.sessionId}`);
    return { session };
  });

  register("session.list", (params: { status?: string; limit?: number; offset?: number }) => {
    const page = db.sessions.list({
      ...(params.status ? { status: params.status as "active" | "archived" } : {}),
      limit: params.limit ?? 50,
      offset: params.offset ?? 0,
    });
    return { sessions: page.items, total: page.total };
  });

  register("session.rename", (params: { sessionId: SessionId; title: string }) => {
    if (!db.sessions.rename(params.sessionId, params.title)) {
      throw new RpcError(ErrorCodes.NOT_FOUND, `session not found: ${params.sessionId}`);
    }
    const session = db.sessions.get(params.sessionId)!;
    bus.emit({ type: "session.updated", sessionId: session.id, title: session.title, tags: session.tags });
    return { session };
  });

  register("session.setTags", (params: { sessionId: SessionId; tags: string[] }) => {
    if (!db.sessions.setTags(params.sessionId, params.tags)) {
      throw new RpcError(ErrorCodes.NOT_FOUND, `session not found: ${params.sessionId}`);
    }
    const session = db.sessions.get(params.sessionId)!;
    bus.emit({ type: "session.updated", sessionId: session.id, title: session.title, tags: session.tags });
    return { session };
  });

  register("session.archive", (params: { sessionId: SessionId }) => {
    if (!db.sessions.archive(params.sessionId)) {
      throw new RpcError(ErrorCodes.NOT_FOUND, `session not found: ${params.sessionId}`);
    }
    bus.emit({ type: "session.archived", sessionId: params.sessionId });
    return { ok: true as const };
  });

  register("session.messages", (params: { sessionId: SessionId; limit?: number }) => {
    const page = db.messages.listBySession(params.sessionId, { limit: params.limit ?? 100 });
    return { messages: page.items };
  });
}
