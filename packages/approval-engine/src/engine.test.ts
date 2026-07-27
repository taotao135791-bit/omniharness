import { beforeEach, describe, expect, it } from "vitest";
import type { ApprovalId, ToolCallId } from "@omniharness/shared-types";
import { ApprovalEngine } from "./engine.js";
import type { ApprovalEvent, CreateApprovalInput } from "./engine.js";
import { InMemoryApprovalStore } from "./store.js";

const START = new Date("2026-01-01T00:00:00.000Z");

let now: Date;
let store: InMemoryApprovalStore;
let events: ApprovalEvent[];
let idCounter: number;
let engine: ApprovalEngine;

function makeInput(overrides?: Partial<CreateApprovalInput>): CreateApprovalInput {
  return {
    toolCallId: "tc_1" as ToolCallId,
    capability: "fs.write",
    risk: "medium",
    summary: "Write file",
    detail: { target: "/workspace/a.txt" },
    sessionId: "sess_1",
    ...overrides,
  };
}

beforeEach(() => {
  now = new Date(START);
  store = new InMemoryApprovalStore();
  events = [];
  idCounter = 0;
  engine = new ApprovalEngine({
    store,
    clock: () => now,
    onEvent: (e) => events.push(e),
    idGenerator: () => `appr_${++idCounter}` as ApprovalId,
  });
});

describe("lifecycle", () => {
  it("create → approve sets fields correctly", async () => {
    const req = await engine.create(makeInput({ timeoutMs: 60_000 }));
    expect(req.id).toBe("appr_1");
    expect(req.status).toBe("pending");
    expect(req.createdAt).toBe(START.toISOString());
    expect(req.expiresAt).toBe(new Date(START.getTime() + 60_000).toISOString());
    expect(req.resolvedAt).toBeNull();
    expect(req.resolvedBy).toBeNull();
    expect(req.detail["sessionId"]).toBe("sess_1");
    expect(req.detail["target"]).toBe("/workspace/a.txt");

    now = new Date(START.getTime() + 1_000);
    const resolved = await engine.resolve(req.id, "approve", "ask_every_time");
    expect(resolved.status).toBe("approved");
    expect(resolved.resolvedBy).toBe("user");
    expect(resolved.resolvedAt).toBe(now.toISOString());
    expect(resolved.grantedScope).toBe("ask_every_time");

    const persisted = await engine.get(req.id);
    expect(persisted?.status).toBe("approved");
  });

  it("uses defaultTimeoutMs (5 min) when timeoutMs is omitted", async () => {
    const req = await engine.create(makeInput());
    expect(req.expiresAt).toBe(new Date(START.getTime() + 5 * 60 * 1000).toISOString());
  });

  it("deny sets status denied and records no grant", async () => {
    const req = await engine.create(makeInput());
    const resolved = await engine.resolve(req.id, "deny");
    expect(resolved.status).toBe("denied");
    expect(resolved.resolvedBy).toBe("user");
    expect(resolved.grantedScope).toBeUndefined();
    expect(engine.consumeSessionGrant("fs.write", "/workspace/a.txt", "sess_1")).toBe(false);
  });

  it("cancel transitions pending → cancelled with resolvedBy null", async () => {
    const req = await engine.create(makeInput());
    const cancelled = await engine.cancel(req.id);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.resolvedBy).toBeNull();
    expect(cancelled.resolvedAt).not.toBeNull();
    expect(events.map((e) => e.type)).toEqual(["approval.requested", "approval.resolved"]);
  });

  it("throws on unknown id and on already-resolved requests", async () => {
    await expect(engine.resolve("appr_nope" as ApprovalId, "approve")).rejects.toThrow(/not found/);
    const req = await engine.create(makeInput());
    await engine.resolve(req.id, "deny");
    await expect(engine.resolve(req.id, "approve")).rejects.toThrow(/already resolved/);
    await expect(engine.cancel(req.id)).rejects.toThrow(/already resolved/);
  });
});

describe("dedupe", () => {
  it("returns the existing pending request and emits a single requested event", async () => {
    const first = await engine.create(makeInput());
    const second = await engine.create(makeInput({ toolCallId: "tc_2" as ToolCallId }));
    expect(second.id).toBe(first.id);
    expect(events.filter((e) => e.type === "approval.requested")).toHaveLength(1);
    expect(await store.list()).toHaveLength(1);
  });

  it("does not dedupe across different targets or sessions", async () => {
    const a = await engine.create(makeInput());
    const b = await engine.create(makeInput({ detail: { target: "/workspace/b.txt" } }));
    const c = await engine.create(makeInput({ sessionId: "sess_2" }));
    expect(new Set([a.id, b.id, c.id]).size).toBe(3);
  });

  it("creates a fresh request after the previous one resolved", async () => {
    const first = await engine.create(makeInput());
    await engine.resolve(first.id, "deny");
    const second = await engine.create(makeInput());
    expect(second.id).not.toBe(first.id);
  });
});

describe("expiry", () => {
  it("lazily expires overdue pending requests on get", async () => {
    const req = await engine.create(makeInput({ timeoutMs: 60_000 }));
    now = new Date(START.getTime() + 61_000);
    const fetched = await engine.get(req.id);
    expect(fetched?.status).toBe("expired");
    expect(fetched?.resolvedBy).toBe("timeout");
    expect(fetched?.resolvedAt).toBe(req.expiresAt);

    const persisted = await store.get(req.id);
    expect(persisted?.status).toBe("expired");
    expect(events.map((e) => e.type)).toEqual(["approval.requested", "approval.resolved"]);
  });

  it("lazily expires on list and resolve throws afterwards", async () => {
    const req = await engine.create(makeInput({ timeoutMs: 60_000 }));
    now = new Date(START.getTime() + 61_000);
    const pending = await engine.list({ status: "pending" });
    expect(pending).toHaveLength(0);
    await expect(engine.resolve(req.id, "approve")).rejects.toThrow(/already resolved/);
  });

  it("sweepExpired expires only overdue pending requests and returns the count", async () => {
    await engine.create(makeInput({ timeoutMs: 60_000 }));
    await engine.create(makeInput({ detail: { target: "/workspace/b.txt" }, timeoutMs: 600_000 }));
    const resolved = await engine.create(
      makeInput({ detail: { target: "/workspace/c.txt" }, timeoutMs: 60_000 }),
    );
    await engine.resolve(resolved.id, "deny");

    now = new Date(START.getTime() + 61_000);
    expect(await engine.sweepExpired()).toBe(1);
    expect(await engine.sweepExpired()).toBe(0);

    const expired = await engine.list({ status: "expired" });
    expect(expired).toHaveLength(1);
    expect(expired[0]?.detail["target"]).toBe("/workspace/a.txt");
  });
});

describe("session grants", () => {
  it("one-time grant (no grantedScope) works once then is gone", async () => {
    const req = await engine.create(makeInput());
    await engine.resolve(req.id, "approve");
    expect(engine.consumeSessionGrant("fs.write", "/workspace/a.txt", "sess_1")).toBe(true);
    expect(engine.consumeSessionGrant("fs.write", "/workspace/a.txt", "sess_1")).toBe(false);
  });

  it("one-time grant for ask_every_time works once", async () => {
    const req = await engine.create(makeInput());
    await engine.resolve(req.id, "approve", "ask_every_time");
    expect(engine.consumeSessionGrant("fs.write", "/workspace/a.txt", "sess_1")).toBe(true);
    expect(engine.consumeSessionGrant("fs.write", "/workspace/a.txt", "sess_1")).toBe(false);
  });

  it("ask_once_per_session persists for same session/target and does not leak", async () => {
    const req = await engine.create(makeInput());
    await engine.resolve(req.id, "approve", "ask_once_per_session");

    expect(engine.consumeSessionGrant("fs.write", "/workspace/a.txt", "sess_1")).toBe(true);
    expect(engine.consumeSessionGrant("fs.write", "/workspace/a.txt", "sess_1")).toBe(true);
    // Different session: no grant.
    expect(engine.consumeSessionGrant("fs.write", "/workspace/a.txt", "sess_2")).toBe(false);
    // Different target: no grant.
    expect(engine.consumeSessionGrant("fs.write", "/workspace/b.txt", "sess_1")).toBe(false);
    // Different capability: no grant.
    expect(engine.consumeSessionGrant("fs.read", "/workspace/a.txt", "sess_1")).toBe(false);
  });

  it("allow_for_workspace matches any target within the session only", async () => {
    const req = await engine.create(makeInput());
    await engine.resolve(req.id, "approve", "allow_for_workspace");

    expect(engine.consumeSessionGrant("fs.write", "/workspace/a.txt", "sess_1")).toBe(true);
    expect(engine.consumeSessionGrant("fs.write", "/workspace/anything-else.txt", "sess_1")).toBe(
      true,
    );
    expect(engine.consumeSessionGrant("fs.write", "/workspace/a.txt", "sess_2")).toBe(false);
    expect(engine.consumeSessionGrant("fs.read", "/workspace/a.txt", "sess_1")).toBe(false);
  });
});

describe("events", () => {
  it("emits approval.requested then approval.resolved in order", async () => {
    const req = await engine.create(makeInput());
    await engine.resolve(req.id, "approve", "ask_once_per_session");
    expect(events.map((e) => e.type)).toEqual(["approval.requested", "approval.resolved"]);
    expect(events[0]?.request.id).toBe(req.id);
    expect(events[1]?.request.status).toBe("approved");
  });

  it("dedupe suppresses duplicate approval.requested events", async () => {
    await engine.create(makeInput());
    await engine.create(makeInput());
    await engine.create(makeInput());
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("approval.requested");
  });
});
