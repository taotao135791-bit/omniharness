import { describe, expect, it } from "vitest";
import { renderHeader, type HeaderState } from "./shell/header.js";
import { renderStatusBar } from "./shell/status-bar.js";
import { ChatViewModel } from "./vm/chat-vm.js";
import { makeApproval, sid, tid } from "./test/harness.js";

const baseHeader: HeaderState = {
  brand: "OmniHarness",
  connection: "connected",
  daemonVersion: "0.1.0",
  sessionTitle: "Refactor auth",
  modelLabel: "GPT-5",
  usageLabel: "↑1.2k ↓300 $0.05",
  pendingApprovals: 2,
  view: "Chat",
};

describe("header / status bar layout", () => {
  it("full width shows everything", () => {
    const [line] = renderHeader(baseHeader, 120);
    expect(line).toContain("OmniHarness");
    expect(line).toContain("●");
    expect(line).toContain("Refactor auth");
    expect(line).toContain("GPT-5");
    expect(line).toContain("⚠2");
    expect(line).toContain("[Chat]");
  });

  it("narrow width collapses to the compact form", () => {
    const [line] = renderHeader(baseHeader, 60);
    expect(line).toContain("OmniHarness");
    expect(line).toContain("GPT-5");
    expect(line).not.toContain("Refactor auth");
    expect([...line!].length).toBeLessThanOrEqual(60);
  });

  it("status bar switches to compact hints under 80 cols", () => {
    expect(renderStatusBar("chat", null, 100)[0]).toContain("shift+enter");
    expect(renderStatusBar("chat", null, 60)[0]).not.toContain("shift+enter");
    expect(renderStatusBar("chat", "saved!", 100)[0]).toContain("saved!");
  });
});

describe("chat view-model layout snapshots", () => {
  it("renders a mixed transcript", () => {
    const vm = new ChatViewModel();
    vm.reset("sess-1", "Test session");
    vm.addUserMessage("please fix the tests");
    vm.applyEvent({
      type: "run.started",
      seq: 1,
      at: "2026-07-22T00:00:00Z",
      sessionId: sid("sess-1"),
      runId: "r1",
      agentId: "a1",
      modelId: "m1",
    });
    vm.applyEvent({
      type: "message.started",
      seq: 2,
      at: "2026-07-22T00:00:01Z",
      sessionId: sid("sess-1"),
      messageId: "m1",
      role: "assistant",
    });
    vm.applyEvent({
      type: "message.delta",
      seq: 3,
      at: "2026-07-22T00:00:02Z",
      sessionId: sid("sess-1"),
      messageId: "m1",
      delta: "Looking at the failures now.",
      channel: "text",
    });
    vm.applyEvent({
      type: "message.completed",
      seq: 4,
      at: "2026-07-22T00:00:03Z",
      sessionId: sid("sess-1"),
      messageId: "m1",
    });
    vm.applyEvent({
      type: "tool.call.started",
      seq: 5,
      at: "2026-07-22T00:00:04Z",
      sessionId: sid("sess-1"),
      toolCallId: tid("t1"),
      toolName: "bash",
      argumentsJson: '{"command":"pnpm test"}',
    });
    vm.applyEvent({
      type: "tool.call.output",
      seq: 6,
      at: "2026-07-22T00:00:05Z",
      sessionId: sid("sess-1"),
      toolCallId: tid("t1"),
      chunk: "3 passed",
      stream: "stdout",
    });
    vm.applyEvent({
      type: "tool.call.completed",
      seq: 7,
      at: "2026-07-22T00:00:06Z",
      sessionId: sid("sess-1"),
      toolCallId: tid("t1"),
      resultJson: "{}",
      durationMs: 900,
    });
    vm.applyEvent({
      type: "approval.requested",
      seq: 8,
      at: "2026-07-22T00:00:07Z",
      approval: makeApproval(),
    });
    expect(vm.renderLines(72)).toMatchSnapshot();
    vm.toggleTool("t1");
    expect(vm.renderLines(72)).toMatchSnapshot();
  });

  it("ignores events for other sessions", () => {
    const vm = new ChatViewModel();
    vm.reset("sess-1", "t");
    const changed = vm.applyEvent({
      type: "message.started",
      seq: 1,
      at: "2026-07-22T00:00:00Z",
      sessionId: sid("sess-OTHER"),
      messageId: "m9",
      role: "assistant",
    });
    expect(changed).toBe(false);
    expect(vm.blocks).toHaveLength(0);
  });
});
