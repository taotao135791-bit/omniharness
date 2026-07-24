import type { DaemonContext } from "../context.js";
import * as git from "@omniharness/git-engine";
import type { WorkspaceId, Worktree, SessionId } from "@omniharness/shared-types";
import { nowIso } from "@omniharness/shared-types";
import { RpcError } from "../rpc-server.js";
import { ErrorCodes, type DiffResult } from "@omniharness/agent-protocol";
import { nanoid } from "./id.js";

type Register = (name: string, handler: (params: never) => unknown) => void;

/** Workspace status, diffs with hunk-level accept/reject, checkpoints, worktrees. */
export function registerWorkspaceHandlers(register: Register, ctx: DaemonContext): void {
  const { db, bus } = ctx;

  const workspaceRoot = (workspaceId: string): string => {
    const ws = db.workspaces.get(workspaceId as WorkspaceId);
    if (!ws) throw new RpcError(ErrorCodes.NOT_FOUND, `workspace not found: ${workspaceId}`);
    const root = ws.roots[0];
    if (!root) throw new RpcError(ErrorCodes.INVALID_PARAMS, "workspace has no roots");
    return root;
  };

  register("workspace.status", async (params: { workspaceId: string }) => {
    const root = workspaceRoot(params.workspaceId);
    if (!(await git.isRepo(root))) {
      return { isGit: false, dirty: false, dirtyFiles: [] };
    }
    const st = await git.status(root);
    return {
      isGit: true,
      ...(st.branch ? { branch: st.branch } : {}),
      dirty: st.dirty,
      dirtyFiles: st.dirtyFiles,
      ahead: st.ahead,
      behind: st.behind,
    };
  });

  register("diff.get", async (params: { workspaceId?: string; worktreeId?: string }) => {
    let root: string;
    if (params.worktreeId) {
      const wt = db.worktrees.get(params.worktreeId as Worktree["id"]);
      if (!wt) throw new RpcError(ErrorCodes.NOT_FOUND, "worktree not found");
      root = wt.path;
    } else if (params.workspaceId) {
      root = workspaceRoot(params.workspaceId);
    } else {
      throw new RpcError(ErrorCodes.INVALID_PARAMS, "workspaceId or worktreeId required");
    }
    if (!(await git.isRepo(root))) throw new RpcError(ErrorCodes.INVALID_PARAMS, "not a git repository");
    const files = await git.diff(root);
    const result: DiffResult = {
      files: files.map((f) => ({
        path: f.path,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        hunks: f.hunks.map((h) => ({ index: h.index, header: h.header, lines: h.lines, accepted: null })),
      })),
      truncated: false,
    };
    return result;
  });

  register("diff.accept", async (params: { workspaceId?: string; file?: string; hunkIndex?: number }) => {
    const root = workspaceRoot(params.workspaceId ?? "");
    const files = await git.diff(root);
    const target = params.file ? files.filter((f) => f.path === params.file) : files;
    if (target.length === 0) throw new RpcError(ErrorCodes.NOT_FOUND, "no matching diff");
    for (const file of target) {
      const hunkIndexes =
        params.hunkIndex !== undefined ? [params.hunkIndex] : file.hunks.map((h) => h.index);
      await git.applyHunks(root, file, hunkIndexes, { cached: false });
    }
    return { ok: true as const };
  });

  register("diff.reject", async (params: { workspaceId?: string; file?: string; hunkIndex?: number }) => {
    const root = workspaceRoot(params.workspaceId ?? "");
    const files = await git.diff(root);
    const target = params.file ? files.filter((f) => f.path === params.file) : files;
    if (target.length === 0) throw new RpcError(ErrorCodes.NOT_FOUND, "no matching diff");
    for (const file of target) {
      const hunkIndexes =
        params.hunkIndex !== undefined ? [params.hunkIndex] : file.hunks.map((h) => h.index);
      // Rejecting = reverse-applying the working-tree change.
      await git.applyHunks(root, file, hunkIndexes, { reverse: true });
    }
    return { ok: true as const };
  });

  register("checkpoint.create", async (params: { sessionId: SessionId; label?: string }) => {
    const session = db.sessions.get(params.sessionId);
    if (!session) throw new RpcError(ErrorCodes.NOT_FOUND, "session not found");
    const root = workspaceRoot(session.workspaceId);
    if (await git.isRepo(root)) {
      const info = await git.checkpointCommit(root, params.label ?? `session ${params.sessionId}`);
      const checkpoint = {
        id: info.id,
        sessionId: params.sessionId,
        kind: "git_commit" as const,
        ref: info.ref,
        createdAt: nowIso(),
        label: info.label,
      };
      db.checkpoints.put(checkpoint);
      return { checkpoint };
    }
    // Non-git workspaces: filesystem snapshot.
    const snapshotId = nanoid("snap");
    const checkpoint = {
      id: snapshotId,
      sessionId: params.sessionId,
      kind: "fs_snapshot" as const,
      ref: snapshotId,
      createdAt: nowIso(),
      label: params.label ?? "snapshot",
    };
    db.checkpoints.put(checkpoint);
    return { checkpoint };
  });

  register("checkpoint.list", (params: { sessionId: SessionId }) => ({
    checkpoints: db.checkpoints.listBySession(params.sessionId),
  }));

  register("checkpoint.restore", async (params: { checkpointId: string }) => {
    const cp = db.checkpoints.get(params.checkpointId as never);
    if (!cp) throw new RpcError(ErrorCodes.NOT_FOUND, "checkpoint not found");
    const session = db.sessions.get(cp.sessionId as SessionId);
    if (!session) throw new RpcError(ErrorCodes.NOT_FOUND, "session not found");
    const root = workspaceRoot(session.workspaceId);
    if (cp.kind === "git_commit") {
      await git.restoreCheckpoint(root, cp.ref);
    } else {
      throw new RpcError(ErrorCodes.INVALID_PARAMS, "fs snapshot restore not wired in this build");
    }
    bus.emit({
      type: "diagnostic",
      level: "info",
      message: `restored checkpoint ${cp.id} (${cp.label})`,
    });
    return { ok: true as const };
  });

  register("worktree.create", async (params: { workspaceId: string; branch?: string; ownerAgentId?: string }) => {
    const root = workspaceRoot(params.workspaceId);
    if (!(await git.isRepo(root))) throw new RpcError(ErrorCodes.INVALID_PARAMS, "worktrees require a git repo");
    const branch = params.branch ?? `omniharness/${nanoid("wt")}`;
    const info = await git.worktreeAdd(root, `${root}-wt-${branch.replaceAll("/", "-")}`, branch);
    const worktree: Worktree = {
      id: nanoid("wt") as Worktree["id"],
      workspaceId: params.workspaceId as WorkspaceId,
      path: info.path,
      branch: info.branch ?? branch,
      ownerAgentId: params.ownerAgentId ?? null,
      createdAt: nowIso(),
    };
    db.worktrees.put(worktree);
    return { worktree };
  });

  register("worktree.list", (params: { workspaceId: string }) => ({
    worktrees: db.worktrees.listByWorkspace(params.workspaceId as WorkspaceId),
  }));

  register("worktree.remove", async (params: { worktreeId: string; force?: boolean }) => {
    const wt = db.worktrees.get(params.worktreeId as Worktree["id"]);
    if (!wt) throw new RpcError(ErrorCodes.NOT_FOUND, "worktree not found");
    const root = workspaceRoot(wt.workspaceId);
    await git.worktreeRemove(root, wt.path, { force: params.force ?? false });
    db.worktrees.delete(wt.id);
    return { ok: true as const };
  });
}
