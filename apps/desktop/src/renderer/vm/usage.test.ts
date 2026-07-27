import { describe, expect, it } from "vitest";
import type { DiagnosticsReport, UsageBucket } from "@omniharness/agent-protocol";
import { diagnosticsProblems, formatBytes, totalUsage, toUsageBars } from "./usage.js";

const buckets: UsageBucket[] = [
  {
    key: "small",
    usage: { inputTokens: 100, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
    requests: 1,
  },
  {
    key: "big",
    usage: {
      inputTokens: 600,
      outputTokens: 200,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.05,
    },
    requests: 3,
  },
];

describe("toUsageBars", () => {
  it("sorts descending and normalizes widths", () => {
    const bars = toUsageBars(buckets);
    expect(bars[0]!.key).toBe("big");
    expect(bars[0]!.width).toBe(1);
    expect(bars[1]!.width).toBeCloseTo(0.25);
  });
  it("handles empty input", () => {
    expect(toUsageBars([])).toEqual([]);
  });
});

describe("totalUsage", () => {
  it("sums tokens, requests and cost", () => {
    const t = totalUsage(buckets);
    expect(t.inputTokens).toBe(700);
    expect(t.outputTokens).toBe(300);
    expect(t.requests).toBe(4);
    expect(t.hasCost).toBe(true);
    expect(t.costUsd).toBeCloseTo(0.05);
  });
});

describe("diagnosticsProblems", () => {
  it("keeps only failing checks", () => {
    const report: DiagnosticsReport = {
      ok: false,
      checks: [
        { name: "db", ok: true, detail: "fine" },
        { name: "net", ok: false, detail: "unreachable" },
      ],
      platform: { os: "macos", arch: "arm64", node: "22" },
      dataDir: "/x",
      dbSizeBytes: 1,
      eventLogSize: 2,
    };
    const problems = diagnosticsProblems(report);
    expect(problems).toEqual([{ name: "net", detail: "unreachable" }]);
    expect(diagnosticsProblems(null)).toEqual([]);
  });
});

describe("formatBytes", () => {
  it("formats sizes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});
