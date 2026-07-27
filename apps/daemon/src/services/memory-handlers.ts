import type { DaemonContext } from "../context.js";
import type { MemoryKind } from "@omniharness/shared-types";

type Register = (name: string, handler: (params: never) => unknown) => void;

/** Memory commands backed by the MemoryEngine. */
export function registerMemoryHandlers(register: Register, ctx: DaemonContext): void {
  const { memory, db, bus } = ctx;

  register("memory.search", (params: {
    text: string;
    profileId?: string;
    projectId?: string;
    limit?: number;
    includePending?: boolean;
  }) => {
    const profileId = (params.profileId ?? db.profiles.getDefault()?.id ?? "") as never;
    const results = memory.search({
      text: params.text,
      profileId,
      ...(params.projectId !== undefined ? { projectId: params.projectId as never } : {}),
      limit: params.limit ?? 10,
      ...(params.includePending !== undefined ? { includePending: params.includePending } : {}),
    });
    return { results };
  });

  register("memory.list", (params: { profileId?: string; approvedOnly?: boolean; limit?: number }) => {
    const profileId = (params.profileId ?? db.profiles.getDefault()?.id ?? "") as never;
    let entries = db.memories.listByProfile(profileId);
    if (params.approvedOnly) entries = entries.filter((m) => m.approvedByUser || m.createdBy === "user");
    return { memories: entries.slice(0, params.limit ?? 50), total: entries.length };
  });

  register("memory.add", (params: { content: string; kind: string; profileId?: string; projectId?: string }) => {
    const profileId = (params.profileId ?? db.profiles.getDefault()?.id ?? "") as never;
    const entry = memory.add({
      content: params.content,
      summary: params.content.slice(0, 120),
      kind: params.kind as MemoryKind,
      profileId,
      projectId: (params.projectId ?? null) as never,
    });
    return { memory: entry };
  });

  register("memory.approve", (params: { memoryId: string }) => {
    memory.approve(params.memoryId as never);
    bus.emit({ type: "memory.approved", memoryId: params.memoryId });
    return { ok: true as const };
  });

  register("memory.reject", (params: { memoryId: string }) => {
    memory.reject(params.memoryId as never);
    bus.emit({ type: "memory.rejected", memoryId: params.memoryId });
    return { ok: true as const };
  });

  register("memory.delete", (params: { memoryId: string }) => {
    memory.delete(params.memoryId as never);
    return { ok: true as const };
  });
}
