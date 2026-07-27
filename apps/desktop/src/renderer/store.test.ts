import { describe, expect, it } from "vitest";
import type {
  CommandName,
  CommandParams,
  CommandResult,
  DomainEvent,
} from "./bridge.js";
import type { OmniBridge } from "./bridge.js";
import { AppStore } from "./store.js";
import type { ApprovalId, SessionId, ToolCallId } from "@omniharness/shared-types";

const SID = "s1" as SessionId;

/** Fake window.omni bridge: canned RPC results + captured event/state handlers. */
class FakeBridge implements OmniBridge {
  calls: Array<{ name: string; params: unknown }> = [];
  private eventHandler: ((e: DomainEvent) => void) | null = null;
  private stateHandler: ((s: string) => void) | null = null;

  emit(event: DomainEvent): void {
    this.eventHandler?.(event);
  }
  setState(state: string): void {
    this.stateHandler?.(state);
  }

  async call<N extends CommandName>(name: N, params: CommandParams<N>): Promise<CommandResult<N>> {
    this.calls.push({ name, params });
    const p = params as Record<string, unknown>;
    let result: unknown;
    switch (name) {
      case "system.ping":
        result = { ok: true, version: "0.1.0", uptimeMs: 1 };
        break;
      case "profile.list":
        result = {
          profiles: [{ id: "p1", name: "default", isDefault: true, createdAt: "2026-01-01" }],
        };
        break;
      case "project.list":
        result = { projects: [{ id: "pr1", name: "proj", createdAt: "2026-01-01" }] };
        break;
      case "workspace.list":
        result = {
          workspaces: [
            {
              id: "w1",
              projectId: "pr1",
              name: "ws",
              kind: "git",
              roots: ["/x"],
              protectedPaths: [],
              readOnlyPaths: [],
              createdAt: "2026-01-01",
            },
          ],
        };
        break;
      case "session.list":
        result = {
          sessions: [
            {
              id: "s1",
              profileId: "p1",
              projectId: "pr1",
              workspaceId: "w1",
              title: "sess",
              tags: [],
              status: "active",
              headMessageId: null,
              createdAt: "2026-01-01",
              updatedAt: "2026-01-01",
              totalUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
            },
          ],
          total: 1,
        };
        break;
      case "session.messages":
        result = {
          messages: [
            {
              id: "m1",
              sessionId: SID,
              parentId: null,
              role: "user",
              parts: [{ type: "text", text: "hi" }],
              createdAt: "2026-01-01",
            },
          ],
        };
        break;
      case "run.list":
        result = { runs: [] };
        break;
      case "agent.list":
        result = { agents: [] };
        break;
      case "checkpoint.list":
        result = { checkpoints: [] };
        break;
      case "approval.list":
        result = { approvals: [] };
        break;
      case "settings.get":
        result = { settings: { gui: { theme: "dark" } } };
        break;
      case "system.diagnostics":
        result = {
          ok: true,
          checks: [{ name: "db", ok: true, detail: "fine" }],
          platform: { os: "macos", arch: "arm64", node: "22" },
          dataDir: "/x",
          dbSizeBytes: 10,
          eventLogSize: 5,
        };
        break;
      case "run.start":
        result = { runId: `run-${String(p["input"])}` };
        break;
      case "approval.resolve":
        result = { approval: { id: p["approvalId"] } };
        break;
      case "diff.get":
        result = { files: [], truncated: false };
        break;
      case "diff.accept":
      case "diff.reject":
        result = { ok: true };
        break;
      case "settings.set":
        result = { ok: true };
        break;
      default:
        throw new Error(`unexpected call: ${name}`);
    }
    return result as CommandResult<N>;
  }

  onEvent(handler: (e: DomainEvent) => void): () => void {
    this.eventHandler = handler;
    return () => {
      this.eventHandler = null;
    };
  }
  onState(handler: (s: string) => void): () => void {
    this.stateHandler = handler;
    return () => {
      this.stateHandler = null;
    };
  }
}

const ev = { seq: 1, at: "2026-01-01T00:00:00Z" };

async function bootedStore(): Promise<{ store: AppStore; bridge: FakeBridge }> {
  const bridge = new FakeBridge();
  const store = new AppStore(bridge);
  store.start();
  await store.bootstrap();
  return { store, bridge };
}

describe("AppStore", () => {
  it("bootstraps profiles, sessions, settings and diagnostics", async () => {
    const { store } = await bootedStore();
    const s = store.snapshot;
    expect(s.version).toBe("0.1.0");
    expect(s.activeProfileId).toBe("p1");
    expect(s.activeProjectId).toBe("pr1");
    expect(s.workspaces[0]!.id).toBe("w1");
    expect(s.sessions[0]!.id).toBe("s1");
    expect(s.theme).toBe("dark");
    expect(s.diagnostics?.ok).toBe(true);
  });

  it("loads history and runs when selecting a session", async () => {
    const { store } = await bootedStore();
    await store.selectSession(SID);
    expect(store.snapshot.chat.messages[0]).toMatchObject({ id: "m1", role: "user", text: "hi" });
    expect(store.snapshot.activeSessionId).toBe("s1");
  });

  it("echoes the user message and tracks the active run on send", async () => {
    const { store } = await bootedStore();
    await store.selectSession(SID);
    await store.send("do it");
    const s = store.snapshot;
    expect(s.chat.messages.at(-1)).toMatchObject({ role: "user", text: "do it" });
    expect(s.chat.activeRunId).toBe("run-do it");
    const startCall = bridgeCall(store, "run.start");
    expect(startCall?.params).toMatchObject({ sessionId: SID, input: "do it" });
  });

  it("routes streaming deltas and run completion into chat state", async () => {
    const { store, bridge } = await bootedStore();
    await store.selectSession(SID);
    await store.send("go");
    bridge.emit({
      ...ev,
      type: "message.delta",
      sessionId: SID,
      messageId: "m2",
      delta: "working",
      channel: "text",
    });
    expect(store.snapshot.chat.messages.at(-1)).toMatchObject({
      id: "m2",
      text: "working",
      streaming: true,
    });
    bridge.emit({
      ...ev,
      type: "run.completed",
      sessionId: SID,
      runId: "run-go",
      usage: { inputTokens: 5, outputTokens: 7 },
    });
    expect(store.snapshot.chat.activeRunId).toBeNull();
    expect(store.snapshot.chat.totals.outputTokens).toBe(7);
  });

  it("handles approval lifecycle events and resolves with remember scope", async () => {
    const { store, bridge } = await bootedStore();
    bridge.emit({
      ...ev,
      type: "approval.requested",
      approval: {
        id: "a1" as ApprovalId,
        toolCallId: "t1" as ToolCallId,
        capability: "shell.exec",
        risk: "high",
        summary: "run ls",
        detail: {},
        status: "pending",
        createdAt: "2026-01-01",
        resolvedAt: null,
        resolvedBy: null,
        expiresAt: "2026-01-02",
      },
    });
    expect(store.snapshot.approvals).toHaveLength(1);
    await store.resolveApproval("a1", "approve", "session");
    const call = bridge.calls.find((c) => c.name === "approval.resolve");
    expect(call?.params).toMatchObject({
      approvalId: "a1",
      decision: "approve",
      rememberScope: "session",
    });
    expect(store.snapshot.approvals).toHaveLength(0);
  });

  it("passes file and hunk index to diff.accept and refreshes", async () => {
    const { store, bridge } = await bootedStore();
    await store.selectSession(SID);
    await store.diffDecision("accept", "src/a.ts", 2);
    const call = bridge.calls.find((c) => c.name === "diff.accept");
    expect(call?.params).toMatchObject({ sessionId: SID, file: "src/a.ts", hunkIndex: 2 });
    expect(bridge.calls.some((c) => c.name === "diff.get")).toBe(true);
  });

  it("saves settings through settings.set and reloads", async () => {
    const { store, bridge } = await bootedStore();
    const ok = await store.saveSetting("gui.theme", "light");
    expect(ok).toBe(true);
    expect(bridge.calls.find((c) => c.name === "settings.set")?.params).toEqual({
      key: "gui.theme",
      value: "light",
    });
  });

  it("bootstraps on reconnect via the state handler", async () => {
    const bridge = new FakeBridge();
    const store = new AppStore(bridge);
    store.start();
    bridge.setState("connected");
    await new Promise((r) => setTimeout(r, 0));
    expect(store.snapshot.daemon).toBe("connected");
    expect(store.snapshot.version).toBe("0.1.0");
  });
});

function bridgeCall(store: AppStore, name: string): { name: string; params: unknown } | undefined {
  const bridge = store.rpc as FakeBridge;
  return bridge.calls.find((c) => c.name === name);
}
