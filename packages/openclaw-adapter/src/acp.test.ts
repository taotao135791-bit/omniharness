import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OmniClient } from "@omniharness/client-sdk";
import type {
  AgentId,
  ApprovalId,
  MessageId,
  ModelId,
  ProfileId,
  SessionId,
  ToolCallId,
  WorkspaceId,
} from "@omniharness/shared-types";
import type { ApprovalRequest } from "@omniharness/shared-types";
import { collectingAudit } from "./audit.js";
import type { AuditEvent } from "./audit.js";
import { ChannelApprovalRelay, OmniAcpRuntime } from "./acp.js";
import type { AcpRuntimeEvent } from "./acp.js";
import { OpenClawAdapter } from "./adapter.js";
import { MockConnector } from "./channels/mock.js";
import { ConnectorRegistry } from "./channels/connector.js";
import { SessionKeyMap, parseSessionDeliveryRoute } from "./session-keys.js";
import { FakeDaemon } from "./testkit/fake-daemon.js";

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function approval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "appr-1" as ApprovalId,
    toolCallId: "tc-9" as ToolCallId,
    capability: "shell.exec",
    risk: "high",
    summary: "Run `rm -rf ./build`",
    detail: { command: "rm -rf ./build" },
    status: "pending",
    createdAt: new Date().toISOString(),
    resolvedAt: null,
    resolvedBy: null,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

describe("OmniAcpRuntime against a fake daemon (ws)", () => {
  let daemon: FakeDaemon;
  let client: OmniClient;

  beforeEach(async () => {
    daemon = new FakeDaemon();
    const port = await daemon.start();
    client = new OmniClient({
      url: `ws://127.0.0.1:${port}`,
      authToken: "test-token",
      client: { kind: "channel", name: "openclaw-adapter-test", version: "0" },
      autoReconnect: false,
    });
    await client.connect();
  });

  afterEach(async () => {
    await client.close();
    await daemon.stop();
  });

  it("ensureSession creates a session and maps the key (with delivery route)", async () => {
    const runtime = new OmniAcpRuntime(client);
    const key = "agent:main:telegram:default:direct:alice";
    const handle = await runtime.ensureSession(key, {
      route: { profileId: "prof-1" as ProfileId, workspaceId: "ws-1" as WorkspaceId },
    });
    expect(handle.sessionId).toBe("sess-1");
    const mapping = runtime.mappings.get(key);
    expect(mapping?.profileId).toBe("prof-1");
    expect(mapping?.deliveryRoute).toEqual(parseSessionDeliveryRoute(key));

    // Second call reuses the session; no second session.create hits the daemon.
    const again = await runtime.ensureSession(key);
    expect(again.sessionId).toBe("sess-1");
    expect(daemon.calls("session.create")).toHaveLength(1);
  });

  it("ensureSession rejects unmapped keys without a route", async () => {
    const runtime = new OmniAcpRuntime(client);
    await expect(runtime.ensureSession("agent:main:main")).rejects.toThrow(/no route provided/);
  });

  it("runTurn streams text_delta/tool_call events and resolves done with usage", async () => {
    // Replace the default daemon with a scripted one.
    await client.close();
    await daemon.stop();
    const scripted = new FakeDaemon((name, params) => {
      if (name === "run.start") {
        const sessionId = params["sessionId"] as SessionId;
        const runId = "run-x";
        setTimeout(() => {
          scripted.emit({
            type: "run.started",
            sessionId,
            runId,
            agentId: "a1" as AgentId,
            modelId: "m1" as ModelId,
          });
          scripted.emit({
            type: "message.started",
            sessionId,
            messageId: "msg-1" as MessageId,
            role: "assistant",
          });
          scripted.emit({
            type: "message.delta",
            sessionId,
            messageId: "msg-1" as MessageId,
            delta: "Hello ",
            channel: "text",
          });
          scripted.emit({
            type: "message.delta",
            sessionId,
            messageId: "msg-1" as MessageId,
            delta: "hmm",
            channel: "reasoning",
          });
          scripted.emit({
            type: "message.delta",
            sessionId,
            messageId: "msg-1" as MessageId,
            delta: "world",
            channel: "text",
          });
          scripted.emit({
            type: "tool.call.started",
            sessionId,
            toolCallId: "tc-1" as ToolCallId,
            toolName: "bash",
            argumentsJson: "{}",
          });
          scripted.emit({
            type: "tool.call.completed",
            sessionId,
            toolCallId: "tc-1" as ToolCallId,
            resultJson: "{}",
            durationMs: 5,
          });
          scripted.emit({
            type: "run.completed",
            sessionId,
            runId,
            usage: { inputTokens: 3, outputTokens: 5 },
          });
        }, 10);
        return { runId };
      }
      return undefined;
    });
    daemon = scripted;
    const port = await daemon.start();
    client = new OmniClient({
      url: `ws://127.0.0.1:${port}`,
      authToken: "test-token",
      client: { kind: "channel", name: "openclaw-adapter-test", version: "0" },
      autoReconnect: false,
    });
    await client.connect();

    const runtime = new OmniAcpRuntime(client);
    const key = "agent:main:telegram:default:direct:alice";
    await runtime.ensureSession(key, {
      route: { profileId: "prof-1" as ProfileId, workspaceId: "ws-1" as WorkspaceId },
    });

    const events: AcpRuntimeEvent[] = [];
    const done = await runtime.runTurn(key, "say hi", { onEvent: (e) => events.push(e) });

    expect(done.status).toBe("ok");
    expect(done.usage).toEqual({ inputTokens: 3, outputTokens: 5 });

    const deltas = events.filter((e) => e.type === "text_delta");
    const outputText = deltas
      .filter((d) => d.type === "text_delta" && (d.stream ?? "output") === "output")
      .map((d) => (d.type === "text_delta" ? d.text : ""))
      .join("");
    expect(outputText).toBe("Hello world");
    expect(deltas.some((d) => d.type === "text_delta" && d.stream === "thought")).toBe(true);

    const toolCalls = events.filter((e) => e.type === "tool_call");
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0]).toMatchObject({ status: "started", text: "bash", toolCallId: "tc-1" });
    expect(toolCalls[1]).toMatchObject({ status: "completed", toolCallId: "tc-1" });
  });

  it("relays approval.requested to the channel and maps yes → approval.resolve", async () => {
    const { sink, events } = collectingAudit();
    const sessionKeys = new SessionKeyMap();
    const sessionKey = "agent:main:telegram:default:direct:alice";
    sessionKeys.register({
      sessionKey,
      sessionId: "sess-1" as SessionId,
      profileId: "prof-1" as ProfileId,
      deliveryRoute: parseSessionDeliveryRoute(sessionKey)!,
    });
    const sent: Array<{ target: string; text: string }> = [];
    const relay = new ChannelApprovalRelay({
      daemon: client,
      sessionKeys,
      send: async (target, text) => {
        sent.push({ target: `${target.channel}:${target.route.peerId}`, text });
      },
      timeoutMs: 5_000,
      audit: sink,
    });
    relay.start();

    const sessionId = "sess-1" as SessionId;
    daemon.emit({
      type: "tool.call.started",
      sessionId,
      toolCallId: "tc-9" as ToolCallId,
      toolName: "bash",
      argumentsJson: "{}",
    });
    daemon.emit({ type: "approval.requested", approval: approval() });

    await waitFor(() => sent.length === 1);
    expect(sent[0]?.target).toBe("telegram:alice");
    expect(sent[0]?.text).toContain("Approval required");
    expect(sent[0]?.text).toContain("shell.exec");

    const consumed = relay.handleChannelReply({ sessionKey, senderId: "alice", body: "yes" });
    expect(consumed).toBe(true);

    await waitFor(() => daemon.calls("approval.resolve").length === 1);
    expect(daemon.calls("approval.resolve")[0]).toMatchObject({
      approvalId: "appr-1",
      decision: "approve",
    });
    await waitFor(() => sent.length === 2);
    expect(sent[1]?.text).toContain("granted");

    const relayed = events.filter((e) => e.kind === "approval.relayed");
    expect(relayed.some((e) => e.kind === "approval.relayed" && e.decision === "approve")).toBe(
      true,
    );
    relay.stop();
  });

  it("maps no → deny and expires without reply after the timeout", async () => {
    const sessionKeys = new SessionKeyMap();
    const sessionKey = "agent:main:telegram:default:direct:alice";
    sessionKeys.register({
      sessionKey,
      sessionId: "sess-1" as SessionId,
      profileId: "prof-1" as ProfileId,
      deliveryRoute: parseSessionDeliveryRoute(sessionKey)!,
    });
    const sent: string[] = [];
    const { sink, events } = collectingAudit();
    const relay = new ChannelApprovalRelay({
      daemon: client,
      sessionKeys,
      send: async (_target, text) => {
        sent.push(text);
      },
      timeoutMs: 60,
      audit: sink,
    });
    relay.start();
    daemon.emit({
      type: "tool.call.started",
      sessionId: "sess-1" as SessionId,
      toolCallId: "tc-9" as ToolCallId,
      toolName: "bash",
      argumentsJson: "{}",
    });
    daemon.emit({ type: "approval.requested", approval: approval({ id: "appr-2" as ApprovalId }) });

    // Times out with no reply: no approval.resolve, timeout notice + audit.
    await waitFor(() => sent.length === 2);
    expect(sent[1]).toContain("timed out");
    expect(daemon.calls("approval.resolve")).toHaveLength(0);
    expect(
      events.some((e: AuditEvent) => e.kind === "approval.relayed" && e.decision === "timeout"),
    ).toBe(true);

    // deny path on a second approval
    daemon.emit({ type: "approval.requested", approval: approval({ id: "appr-3" as ApprovalId }) });
    await waitFor(() => sent.length === 3);
    expect(relay.handleChannelReply({ sessionKey, senderId: "alice", body: "no" })).toBe(true);
    await waitFor(() => daemon.calls("approval.resolve").length === 1);
    expect(daemon.calls("approval.resolve")[0]).toMatchObject({
      approvalId: "appr-3",
      decision: "deny",
    });
    relay.stop();
  });

  it("does not relay approvals for sessions without a channel route", async () => {
    const sessionKeys = new SessionKeyMap();
    const sent: string[] = [];
    const relay = new ChannelApprovalRelay({
      daemon: client,
      sessionKeys,
      send: async (_t, text) => {
        sent.push(text);
      },
    });
    relay.start();
    daemon.emit({
      type: "tool.call.started",
      sessionId: "sess-unrelated" as SessionId,
      toolCallId: "tc-1" as ToolCallId,
      toolName: "bash",
      argumentsJson: "{}",
    });
    daemon.emit({ type: "approval.requested", approval: approval() });
    await new Promise((r) => setTimeout(r, 100));
    expect(sent).toHaveLength(0);
    relay.stop();
  });
});

describe("OpenClawAdapter end-to-end (fake daemon + mock connector)", () => {
  it("routes an inbound channel message through a turn and replies", async () => {
    const daemon = new FakeDaemon((name, params) => {
      if (name === "run.start") {
        const sessionId = params["sessionId"] as SessionId;
        const runId = "run-1";
        setTimeout(() => {
          daemon.emit({
            type: "message.delta",
            sessionId,
            messageId: "m1" as MessageId,
            delta: "Hello ",
            channel: "text",
          });
          daemon.emit({
            type: "message.delta",
            sessionId,
            messageId: "m1" as MessageId,
            delta: "world",
            channel: "text",
          });
          daemon.emit({
            type: "run.completed",
            sessionId,
            runId,
            usage: { inputTokens: 1, outputTokens: 2 },
          });
        }, 10);
        return { runId };
      }
      return undefined;
    });
    const port = await daemon.start();
    const client = new OmniClient({
      url: `ws://127.0.0.1:${port}`,
      authToken: "t",
      client: { kind: "channel", name: "test", version: "0" },
      autoReconnect: false,
    });
    await client.connect();

    const telegram = new MockConnector("telegram");
    const connectors = new ConnectorRegistry();
    connectors.add(telegram);

    const { sink, events } = collectingAudit();
    const adapter = new OpenClawAdapter({
      daemon: client,
      connectors,
      audit: sink,
      routerConfig: {
        accounts: [
          {
            channel: "telegram",
            dmPolicy: "allowlist",
            allowFrom: ["alice"],
            route: { profileId: "prof-1" as ProfileId, workspaceId: "ws-1" as WorkspaceId },
          },
        ],
      },
    });
    await adapter.start();

    telegram.inject({
      Provider: "telegram",
      AccountId: "default",
      From: "alice",
      ChatType: "direct",
      SenderId: "alice",
      Body: "hi there",
    });
    await waitFor(() => telegram.sent.length === 1);
    expect(telegram.sent[0]).toMatchObject({ to: "alice", text: "Hello world" });

    // Denied sender: no turn, no reply, audited denial.
    telegram.inject({
      Provider: "telegram",
      AccountId: "default",
      From: "mallory",
      ChatType: "direct",
      SenderId: "mallory",
      Body: "let me in",
      SessionKey: "agent:main:main", // forged — must not matter
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(telegram.sent).toHaveLength(1);
    expect(daemon.calls("run.start")).toHaveLength(1);
    expect(
      events.some((e) => e.kind === "authz.decision" && !e.allowed && e.senderId === "mallory"),
    ).toBe(true);

    await adapter.stop();
    await client.close();
    await daemon.stop();
  });
});
