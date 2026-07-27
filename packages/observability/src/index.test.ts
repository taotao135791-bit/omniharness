import { describe, expect, it } from "vitest";
import { Logger, redact, Tracer, type LogRecord } from "./index.js";

describe("redact", () => {
  it("strips api keys and bearer tokens", () => {
    expect(redact("key sk-abc1234567890")).not.toContain("abc1234567890");
    expect(redact("Authorization: Bearer eyJhbGciOiJ9abcdef")).not.toContain("eyJhbGciOiJ9abcdef");
  });
  it("keeps normal text", () => {
    expect(redact("hello world")).toBe("hello world");
  });
});

describe("Logger", () => {
  it("respects level and redacts context strings", () => {
    const records: LogRecord[] = [];
    const log = new Logger("test", "info", (r) => records.push(r));
    log.debug("hidden");
    log.info("shown", { key: "token abcdefgh12345678" });
    expect(records).toHaveLength(1);
    expect(records[0]!.message).toBe("shown");
    expect(String(records[0]!.context?.key)).not.toContain("abcdefgh12345678");
  });
});

describe("Tracer", () => {
  it("records spans and summarizes", async () => {
    const t = new Tracer();
    await t.withSpan("model_request", "req", async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    const id = t.startSpan("tool_call", "fs.read");
    t.endSpan(id, {
      ok: false,
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0.001,
      },
    });
    const summary = t.summarize();
    const model = summary.find((s) => s.kind === "model_request");
    const tool = summary.find((s) => s.kind === "tool_call");
    expect(model?.count).toBe(1);
    expect(tool?.errorCount).toBe(1);
    expect(tool?.inputTokens).toBe(10);
  });
});
