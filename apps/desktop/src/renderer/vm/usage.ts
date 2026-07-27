import type { UsageBucket } from "@omniharness/agent-protocol";
import type { DiagnosticsReport } from "@omniharness/agent-protocol";

/**
 * Usage / diagnostics view-model: turns usage buckets into normalized bar
 * rows (no chart library) and splits diagnostics into problem lists.
 */

export interface UsageBar {
  key: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  requests: number;
  totalTokens: number;
  /** 0..1 fraction of the largest bucket, for bar width. */
  width: number;
}

export function toUsageBars(buckets: UsageBucket[]): UsageBar[] {
  const rows = buckets.map((b) => {
    const total = b.usage.inputTokens + b.usage.outputTokens;
    return {
      key: b.key,
      inputTokens: b.usage.inputTokens,
      outputTokens: b.usage.outputTokens,
      costUsd: b.usage.costUsd ?? null,
      requests: b.requests,
      totalTokens: total,
      width: 0,
    };
  });
  rows.sort((a, b) => b.totalTokens - a.totalTokens);
  const max = rows.length > 0 ? rows[0]!.totalTokens : 0;
  for (const r of rows) r.width = max > 0 ? r.totalTokens / max : 0;
  return rows;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  hasCost: boolean;
  requests: number;
}

export function totalUsage(buckets: UsageBucket[]): UsageTotals {
  const t: UsageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    hasCost: false,
    requests: 0,
  };
  for (const b of buckets) {
    t.inputTokens += b.usage.inputTokens;
    t.outputTokens += b.usage.outputTokens;
    t.requests += b.requests;
    if (b.usage.costUsd !== undefined) {
      t.costUsd += b.usage.costUsd;
      t.hasCost = true;
    }
  }
  return t;
}

export interface Problem {
  name: string;
  detail: string;
}

/** Failing diagnostics checks, surfaced in the bottom-panel Problems tab. */
export function diagnosticsProblems(report: DiagnosticsReport | null): Problem[] {
  if (!report) return [];
  return report.checks.filter((c) => !c.ok).map((c) => ({ name: c.name, detail: c.detail }));
}

export function formatBytes(n: number): string {
  if (n >= 1_073_741_824) return `${(n / 1_073_741_824).toFixed(1)} GB`;
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}
