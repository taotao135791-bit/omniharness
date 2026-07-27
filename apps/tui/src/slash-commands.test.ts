import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeDaemon } from "./test/fake-daemon.js";
import {
  connectController,
  makeSession,
  registerBaseHandlers,
  sid,
  type TestHarness,
} from "./test/harness.js";

describe("slash commands", () => {
  let daemon: FakeDaemon;
  let harness: TestHarness;
  const session = makeSession();

  beforeEach(async () => {
    daemon = await FakeDaemon.start();
    registerBaseHandlers(daemon, [session]);
    daemon.on("session.get", (params) => ({
      session: makeSession({ id: params.sessionId as string }),
    }));
    daemon.on("session.messages", () => ({ messages: [] }));
    daemon.on("session.rename", (params) => ({
      session: makeSession({ title: params.title as string }),
    }));
    daemon.on("session.create", () => ({ session: makeSession({ id: "s-new" }) }));
    daemon.on("session.archive", () => ({ ok: true }));
    daemon.on("model.setRoleBinding", () => ({ ok: true }));
    daemon.on("checkpoint.create", (params) => ({
      checkpoint: {
        id: "cp-1",
        sessionId: params.sessionId,
        kind: "git_commit",
        ref: "abc",
        createdAt: "2026-07-22T00:00:00.000Z",
        label: params.label ?? "checkpoint",
      },
    }));
    daemon.on("checkpoint.list", () => ({ checkpoints: [] }));
    daemon.on("checkpoint.restore", () => ({ ok: true }));
    daemon.on("usage.summary", () => ({
      usage: [
        {
          key: "gpt-test",
          usage: {
            inputTokens: 1000,
            outputTokens: 200,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            costUsd: 0.05,
          },
          requests: 3,
        },
      ],
    }));
    harness = await connectController(daemon);
    await harness.controller.openSession(sid("sess-1"));
  });

  afterEach(async () => {
    await harness.client.close();
    await daemon.close();
  });

  it("/model <id> binds the primary role", async () => {
    await harness.controller.submitChat("/model gpt-5");
    expect(daemon.lastCommand("model.setRoleBinding")?.params).toMatchObject({
      role: "primary",
      modelId: "gpt-5",
      scope: "session",
      sessionId: sid("sess-1"),
    });
  });

  it("/session rename sends session.rename", async () => {
    await harness.controller.submitChat("/session rename My new title");
    expect(daemon.lastCommand("session.rename")?.params).toEqual({
      sessionId: sid("sess-1"),
      title: "My new title",
    });
  });

  it("/session new creates in the current workspace and opens it", async () => {
    await harness.controller.submitChat("/session new followup work");
    expect(daemon.lastCommand("session.create")?.params).toEqual({
      workspaceId: "ws-1",
      title: "followup work",
    });
    expect(harness.controller.currentSession?.id).toBe("s-new");
  });

  it("/session archive archives and returns to sessions view", async () => {
    await harness.controller.submitChat("/session archive");
    expect(daemon.lastCommand("session.archive")?.params).toEqual({ sessionId: "sess-1" });
    expect(harness.controller.view).toBe("sessions");
  });

  it("/checkpoint create and restore", async () => {
    await harness.controller.submitChat("/checkpoint create before-refactor");
    expect(daemon.lastCommand("checkpoint.create")?.params).toEqual({
      sessionId: sid("sess-1"),
      label: "before-refactor",
    });
    await harness.controller.submitChat("/checkpoint restore cp-1");
    expect(daemon.lastCommand("checkpoint.restore")?.params).toEqual({ checkpointId: "cp-1" });
  });

  it("/usage prints usage.summary into the transcript", async () => {
    await harness.controller.submitChat("/usage");
    expect(daemon.commandsNamed("usage.summary")).toHaveLength(1);
    const text = harness.controller.chat.renderLines(100).join("\n");
    expect(text).toContain("gpt-test");
  });

  it("/help lists commands; unknown commands get a hint", async () => {
    await harness.controller.submitChat("/help");
    let text = harness.controller.chat.renderLines(100).join("\n");
    expect(text).toContain("/model");
    expect(text).toContain("/checkpoint");

    await harness.controller.submitChat("/bogus");
    text = harness.controller.chat.renderLines(100).join("\n");
    expect(text).toContain("unknown command: /bogus");
  });

  it("/compact-status reports from local state", async () => {
    await harness.controller.submitChat("/compact-status");
    const text = harness.controller.chat.renderLines(100).join("\n");
    expect(text).toContain("session tokens");
    expect(text).toContain("no compaction yet");
  });
});
