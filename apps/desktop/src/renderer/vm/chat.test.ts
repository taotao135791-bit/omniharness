import { describe, expect, it } from "vitest";
import type { Message, MessageId, SessionId, ToolCallId } from "@omniharness/shared-types";
import {
  appendUserMessage,
  chatStateFromHistory,
  emptyChatState,
  formatCost,
  formatTokens,
  reduceChatEvent,
} from "./chat.js";

const SID = "s1" as SessionId;
const TC = "t1" as ToolCallId;
const base = { seq: 1, at: "2026-01-01T00:00:00Z" };

describe("reduceChatEvent", () => {
  it("appends text deltas and completes the message", () => {
    let s = emptyChatState();
    s = reduceChatEvent(s, SID, {
      ...base,
      type: "message.started",
      sessionId: SID,
      messageId: "m1",
      role: "assistant",
    });
    s = reduceChatEvent(s, SID, {
      ...base,
      type: "message.delta",
      sessionId: SID,
      messageId: "m1",
      delta: "Hello",
      channel: "text",
    });
    s = reduceChatEvent(s, SID, {
      ...base,
      type: "message.delta",
      sessionId: SID,
      messageId: "m1",
      delta: " world",
      channel: "text",
    });
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]!.text).toBe("Hello world");
    expect(s.messages[0]!.streaming).toBe(true);
    s = reduceChatEvent(s, SID, {
      ...base,
      type: "message.completed",
      sessionId: SID,
      messageId: "m1",
    });
    expect(s.messages[0]!.streaming).toBe(false);
  });

  it("keeps reasoning deltas in a separate channel", () => {
    let s = emptyChatState();
    s = reduceChatEvent(s, SID, {
      ...base,
      type: "message.delta",
      sessionId: SID,
      messageId: "m1",
      delta: "thinking…",
      channel: "reasoning",
    });
    expect(s.messages[0]!.reasoning).toBe("thinking…");
    expect(s.messages[0]!.text).toBe("");
  });

  it("tracks tool call lifecycle with duration", () => {
    let s = emptyChatState();
    s = reduceChatEvent(s, SID, {
      ...base,
      type: "tool.call.started",
      sessionId: SID,
      toolCallId: TC,
      toolName: "shell",
      argumentsJson: '{"cmd":"ls"}',
    });
    expect(s.toolCalls[0]!.status).toBe("running");
    s = reduceChatEvent(s, SID, {
      ...base,
      type: "tool.call.output",
      sessionId: SID,
      toolCallId: TC,
      chunk: "file.txt\n",
      stream: "stdout",
    });
    s = reduceChatEvent(s, SID, {
      ...base,
      type: "tool.call.completed",
      sessionId: SID,
      toolCallId: TC,
      resultJson: "{}",
      durationMs: 42,
    });
    const t = s.toolCalls[0]!;
    expect(t.status).toBe("completed");
    expect(t.output).toBe("file.txt\n");
    expect(t.durationMs).toBe(42);
  });

  it("marks denied tool calls", () => {
    let s = emptyChatState();
    s = reduceChatEvent(s, SID, {
      ...base,
      type: "tool.call.denied",
      sessionId: SID,
      toolCallId: TC,
      reason: "policy",
    });
    expect(s.toolCalls[0]!.status).toBe("denied");
    expect(s.toolCalls[0]!.error).toBe("policy");
  });

  it("accumulates usage totals on run.completed and clears the run", () => {
    let s = emptyChatState();
    s = reduceChatEvent(s, SID, {
      ...base,
      type: "run.started",
      sessionId: SID,
      runId: "r1",
      agentId: "a1",
      modelId: "m",
    });
    expect(s.activeRunId).toBe("r1");
    s = reduceChatEvent(s, SID, {
      ...base,
      type: "run.completed",
      sessionId: SID,
      runId: "r1",
      usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.01 },
    });
    expect(s.activeRunId).toBeNull();
    expect(s.totals.inputTokens).toBe(100);
    expect(s.totals.costUsd).toBeCloseTo(0.01);
    expect(formatCost(s.totals)).toBe("$0.0100");
  });

  it("records failures and clears streaming", () => {
    let s = emptyChatState();
    s = reduceChatEvent(s, SID, {
      ...base,
      type: "message.delta",
      sessionId: SID,
      messageId: "m1",
      delta: "partial",
      channel: "text",
    });
    s = reduceChatEvent(s, SID, {
      ...base,
      type: "run.failed",
      sessionId: SID,
      runId: "r1",
      error: "boom",
    });
    expect(s.lastError).toBe("boom");
    expect(s.messages[0]!.streaming).toBe(false);
  });

  it("surfaces compaction state", () => {
    let s = emptyChatState();
    s = reduceChatEvent(s, SID, {
      ...base,
      type: "run.compacting",
      sessionId: SID,
      runId: "r1",
      beforeTokens: 90000,
    });
    expect(s.compacting).toBe(true);
    s = reduceChatEvent(s, SID, {
      ...base,
      type: "run.compacted",
      sessionId: SID,
      runId: "r1",
      afterTokens: 12000,
    });
    expect(s.compacting).toBe(false);
    expect(s.compactionNote).toContain("12.0k");
    s = reduceChatEvent(s, SID, {
      ...base,
      type: "run.started",
      sessionId: SID,
      runId: "r2",
      agentId: "a1",
      modelId: "m",
    });
    expect(s.compactionNote).toBeNull();
  });

  it("ignores events for other sessions", () => {
    const s = emptyChatState();
    const next = reduceChatEvent(s, SID, {
      ...base,
      type: "message.delta",
      sessionId: "other" as SessionId,
      messageId: "m1",
      delta: "x",
      channel: "text",
    });
    expect(next).toBe(s);
  });
});

describe("chatStateFromHistory", () => {
  it("maps message parts including tool calls and results", () => {
    const messages: Message[] = [
      {
        id: "m1" as MessageId,
        sessionId: SID,
        parentId: null,
        role: "user",
        parts: [{ type: "text", text: "hi" }],
        createdAt: "2026-01-01T00:00:00Z",
      },
      {
        id: "m2" as MessageId,
        sessionId: SID,
        parentId: "m1" as MessageId,
        role: "assistant",
        parts: [
          { type: "reasoning", text: "let me think" },
          { type: "text", text: "answer" },
          { type: "tool_call", toolCallId: TC, toolName: "shell", argumentsJson: "{}" },
        ],
        createdAt: "2026-01-01T00:00:01Z",
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
      {
        id: "m3" as MessageId,
        sessionId: SID,
        parentId: "m2" as MessageId,
        role: "tool",
        parts: [{ type: "tool_result", toolCallId: TC, resultJson: "ok", isError: false }],
        createdAt: "2026-01-01T00:00:02Z",
      },
    ];
    const s = chatStateFromHistory(messages);
    expect(s.messages).toHaveLength(3);
    expect(s.messages[1]!.reasoning).toBe("let me think");
    expect(s.toolCalls[0]!.name).toBe("shell");
    expect(s.toolCalls[0]!.status).toBe("completed");
    expect(s.totals.inputTokens).toBe(10);
  });
});

describe("appendUserMessage / formatTokens", () => {
  it("appends a user message", () => {
    const s = appendUserMessage(emptyChatState(), "l1", "hello");
    expect(s.messages[0]).toMatchObject({ id: "l1", role: "user", text: "hello" });
  });
  it("formats token counts", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1500)).toBe("1.5k");
    expect(formatTokens(2_500_000)).toBe("2.5M");
  });
});
