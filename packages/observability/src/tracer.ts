import type { TokenUsage } from "@omniharness/shared-types";

/**
 * Local trace system: every agent turn, model request, tool call, approval,
 * compaction, memory retrieval, skill routing, computer action and automation
 * produces spans. Spans are in-memory ring-buffered for the diagnostics UI and
 * summarized into the model_usage table by the daemon.
 */

export type SpanKind =
  | "agent_turn"
  | "model_request"
  | "tool_call"
  | "approval"
  | "retry"
  | "error"
  | "context_build"
  | "compaction"
  | "memory_retrieval"
  | "skill_routing"
  | "computer_action"
  | "automation"
  | "subagent"
  | "artifact";

export interface Span {
  id: string;
  parentId: string | null;
  kind: SpanKind;
  name: string;
  startedAt: number; // ms epoch
  endedAt: number | null;
  ok: boolean | null;
  attributes: Record<string, string | number | boolean>;
  usage?: TokenUsage;
}

export interface SpanSummary {
  kind: SpanKind;
  count: number;
  totalMs: number;
  errorCount: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export class Tracer {
  private spans: Span[] = [];
  private active = new Map<string, Span>();
  private seq = 0;
  constructor(private readonly capacity = 5000) {}

  startSpan(kind: SpanKind, name: string, parentId: string | null = null, attributes: Span["attributes"] = {}): string {
    const id = `sp-${++this.seq}`;
    const span: Span = {
      id,
      parentId,
      kind,
      name,
      startedAt: Date.now(),
      endedAt: null,
      ok: null,
      attributes,
    };
    this.active.set(id, span);
    return id;
  }

  endSpan(id: string, opts: { ok: boolean; attributes?: Span["attributes"]; usage?: TokenUsage }): void {
    const span = this.active.get(id);
    if (!span) return;
    this.active.delete(id);
    span.endedAt = Date.now();
    span.ok = opts.ok;
    if (opts.attributes) Object.assign(span.attributes, opts.attributes);
    if (opts.usage) span.usage = opts.usage;
    this.spans.push(span);
    if (this.spans.length > this.capacity) this.spans.splice(0, this.spans.length - this.capacity);
  }

  /** Run a function inside a span. */
  async withSpan<T>(
    kind: SpanKind,
    name: string,
    fn: () => Promise<T>,
    attributes: Span["attributes"] = {},
  ): Promise<T> {
    const id = this.startSpan(kind, name, null, attributes);
    try {
      const result = await fn();
      this.endSpan(id, { ok: true });
      return result;
    } catch (err) {
      this.endSpan(id, { ok: false, attributes: { error: err instanceof Error ? err.message : String(err) } });
      throw err;
    }
  }

  recent(limit = 100): Span[] {
    return this.spans.slice(-limit);
  }

  summarize(sinceMs?: number): SpanSummary[] {
    const cutoff = sinceMs ?? 0;
    const buckets = new Map<SpanKind, SpanSummary>();
    for (const s of this.spans) {
      if (s.startedAt < cutoff || s.endedAt === null) continue;
      let b = buckets.get(s.kind);
      if (!b) {
        b = { kind: s.kind, count: 0, totalMs: 0, errorCount: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
        buckets.set(s.kind, b);
      }
      b.count += 1;
      b.totalMs += s.endedAt - s.startedAt;
      if (s.ok === false) b.errorCount += 1;
      if (s.usage) {
        b.inputTokens += s.usage.inputTokens;
        b.outputTokens += s.usage.outputTokens;
        b.costUsd += s.usage.costUsd ?? 0;
      }
    }
    return [...buckets.values()];
  }

  clear(): void {
    this.spans = [];
    this.active.clear();
  }
}
