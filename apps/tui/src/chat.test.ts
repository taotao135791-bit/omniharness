import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeDaemon } from "./test/fake-daemon.js";
import {
  connectController,
  makeApproval,
  makeMessage,
  makeSession,
  registerBaseHandlers,
  sid,
  tid,
  waitFor,
  type TestHarness,
} from "./test/harness.js";

describe("chat", () => {
  let daemon: FakeDaemon;
  let harness: TestHarness;
  const session = makeSession();

  beforeEach(async () => {
    daemon = await FakeDaemon.start();
    registerBaseHandlers(daemon, [session]);
    daemon.on("session.get", () => ({ session }));
    daemon.on("session.messages", () => ({
      messages: [
        makeMessage({ id: "m0", role: "user", parts: [{ type: "text", text: "earlier question" }] }),
        makeMessage({
          id: "m1",
          role: "assistant",
          parts: [{ type: "text", text: "earlier **answer**" }],
        }),
      ],
    }));
    daemon.on("run.start", () => ({ runId: "run-1" }));
    daemon.on("run.steer", () => ({ ok: true }));
    daemon.on("run.interrupt", () => ({ ok: true }));
    daemon.on("approval.resolve", (params) => ({
      approval: makeApproval({
        id: params.approvalId as string,
        status: params.decision === "approve" ? "approved" : "denied",
      }),
    }));
    harness = await connectController(daemon);
    await harness.controller.openSession(sid("sess-1"));
  });

  afterEach(async () => {
    await harness.client.close();
    await daemon.close();
  });

  it("loads history and echoes the user message on submit", async () => {
    const vm = harness.controller.chat;
    expect(vm.blocks.filter((b) => b.kind === "user")).toHaveLength(1);
    expect(vm.blocks.filter((b) => b.kind === "assistant")).toHaveLength(1);

    await harness.controller.submitChat("fix the bug");
    expect(daemon.lastCommand("run.start")?.params).toMatchObject({
      sessionId: sid("sess-1"),
      input: "fix the bug",
    });
    const userBlocks = vm.blocks.filter((b) => b.kind === "user");
    expect(userBlocks).toHaveLength(2);
    expect(userBlocks[1]).toMatchObject({ text: "fix the bug" });
  });

  it("renders streamed deltas in order", async () => {
    await harness.controller.submitChat("hi");
    daemon.emit({ type: "run.started", sessionId: sid("sess-1"), runId: "run-1", agentId: "a1", modelId: "model-1" });
    daemon.emit({ type: "message.started", sessionId: sid("sess-1"), messageId: "m2", role: "assistant" });
    daemon.emit({ type: "message.delta", sessionId: sid("sess-1"), messageId: "m2", delta: "Hello ", channel: "text" });
    daemon.emit({ type: "message.delta", sessionId: sid("sess-1"), messageId: "m2", delta: "world", channel: "text" });
    daemon.emit({ type: "message.delta", sessionId: sid("sess-1"), messageId: "m2", delta: "!", channel: "text" });
    daemon.emit({ type: "message.completed", sessionId: sid("sess-1"), messageId: "m2" });
    daemon.emit({ type: "run.completed", sessionId: sid("sess-1"), runId: "run-1", usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.01 } });

    await waitFor(() => {
      const block = harness.controller.chat.blocks.find(
        (b) => b.kind === "assistant" && b.messageId === "m2",
      );
      return block !== undefined && block.kind === "assistant" && !block.streaming;
    });
    const vm = harness.controller.chat;
    const block = vm.blocks.find((b) => b.kind === "assistant" && b.messageId === "m2");
    expect(block).toMatchObject({ text: "Hello world!", streaming: false });
    // usage meter accumulated from run.completed
    expect(vm.usage.inputTokens).toBe(100);
    expect(vm.usage.outputTokens).toBe(20);
    expect(vm.usage.costUsd).toBeCloseTo(0.01);
    expect(vm.activeRun).toBeNull();
  });

  it("collapses tool blocks by default and expands on toggle", async () => {
    await harness.controller.submitChat("run something");
    daemon.emit({ type: "run.started", sessionId: sid("sess-1"), runId: "run-1", agentId: "a1", modelId: "model-1" });
    daemon.emit({
      type: "tool.call.started",
      sessionId: sid("sess-1"),
      toolCallId: tid("tc-1"),
      toolName: "bash",
      argumentsJson: JSON.stringify({ command: "ls -la" }),
    });
    daemon.emit({ type: "tool.call.output", sessionId: sid("sess-1"), toolCallId: tid("tc-1"), chunk: "total 5\n", stream: "stdout" });
    daemon.emit({ type: "tool.call.completed", sessionId: sid("sess-1"), toolCallId: tid("tc-1"), resultJson: "{}", durationMs: 42 });

    await waitFor(() => {
      const b = harness.controller.chat.toolBlocks()[0];
      return b !== undefined && b.status === "done";
    });
    const vm = harness.controller.chat;
    const tool = vm.toolBlocks()[0]!;
    expect(tool.expanded).toBe(false);

    const collapsed = vm.renderLines(80).join("\n");
    expect(collapsed).toContain("bash(ls -la)");
    expect(collapsed).toContain("42ms");
    expect(collapsed).not.toContain("total 5");

    vm.toggleTool("tc-1");
    const expanded = vm.renderLines(80).join("\n");
    expect(expanded).toContain("total 5");
  });

  it("approval flow: approve sends approval.resolve with remember scope", async () => {
    daemon.emit({ type: "approval.requested", approval: makeApproval({ id: "appr-9" }) });
    await waitFor(() => harness.controller.pendingApproval?.id === "appr-9");

    await harness.controller.resolveApproval("appr-9", "approve", "session");
    expect(daemon.lastCommand("approval.resolve")?.params).toEqual({
      approvalId: "appr-9",
      decision: "approve",
      rememberScope: "ask_once_per_session",
    });
    await waitFor(() => harness.controller.pendingApproval === null);
  });

  it("deny sends no rememberScope", async () => {
    daemon.emit({ type: "approval.requested", approval: makeApproval({ id: "appr-10" }) });
    await waitFor(() => harness.controller.pendingApproval?.id === "appr-10");
    await harness.controller.resolveApproval("appr-10", "deny", "once");
    expect(daemon.lastCommand("approval.resolve")?.params).toEqual({
      approvalId: "appr-10",
      decision: "deny",
    });
  });

  it("enter while running steers; interrupt sends run.interrupt", async () => {
    await harness.controller.submitChat("start");
    daemon.emit({ type: "run.started", sessionId: sid("sess-1"), runId: "run-1", agentId: "a1", modelId: "model-1" });
    await waitFor(() => harness.controller.chat.activeRun?.runId === "run-1");

    await harness.controller.submitChat("actually, do it differently");
    expect(daemon.lastCommand("run.steer")?.params).toEqual({
      runId: "run-1",
      input: "actually, do it differently",
    });
    expect(daemon.commandsNamed("run.start")).toHaveLength(1);

    await harness.controller.interrupt();
    expect(daemon.lastCommand("run.interrupt")?.params).toEqual({ runId: "run-1" });
  });

  it("compaction events produce an indicator block", async () => {
    await harness.controller.submitChat("start");
    daemon.emit({ type: "run.started", sessionId: sid("sess-1"), runId: "run-1", agentId: "a1", modelId: "model-1" });
    daemon.emit({ type: "run.compacting", sessionId: sid("sess-1"), runId: "run-1", beforeTokens: 120000 });
    await waitFor(() => harness.controller.chat.blocks.some((b) => b.kind === "compaction"));
    daemon.emit({ type: "run.compacted", sessionId: sid("sess-1"), runId: "run-1", afterTokens: 20000 });
    await waitFor(() => {
      const b = harness.controller.chat.blocks.find((bb) => bb.kind === "compaction");
      return b?.kind === "compaction" && b.done;
    });
    const text = harness.controller.chat.renderLines(80).join("\n");
    expect(text).toContain("compacted");
    expect(harness.controller.compactionStatusText()).toContain("120000");
  });
});
