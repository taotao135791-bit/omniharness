import type { FinishReason, ModelStreamChunk, TokenUsage } from "@omniharness/shared-types";
import { ProviderHttpError } from "./errors.js";
import type { CompletionRequest, ModelProvider } from "./types.js";

/** One scripted response: either a chunk sequence to stream or an error to throw. */
export type FixtureResponse =
  | { kind: "chunks"; chunks: ModelStreamChunk[] }
  | { kind: "error"; error: unknown };

const zeroUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** Deterministic response builders for FixtureProvider scripts. */
export const fixture = {
  /** A plain text answer, streamed one delta per string part. */
  text(
    parts: string | string[],
    options?: { usage?: Partial<TokenUsage>; finishReason?: FinishReason },
  ): FixtureResponse {
    const chunks: ModelStreamChunk[] = (Array.isArray(parts) ? parts : [parts]).map((text) => ({
      type: "text_delta",
      text,
    }));
    if (options?.usage !== undefined) chunks.push({ type: "usage", usage: { ...zeroUsage, ...options.usage } });
    chunks.push({ type: "finish", finishReason: options?.finishReason ?? "stop" });
    return { kind: "chunks", chunks };
  },

  /** A complete tool call (start + end) followed by a tool_calls finish. */
  toolCall(name: string, argumentsJson: string, id = "call_1"): FixtureResponse {
    return {
      kind: "chunks",
      chunks: [
        { type: "tool_call_start", toolCall: { id, name, argumentsJson: "" } },
        { type: "tool_call_delta", toolCallId: id, text: argumentsJson },
        { type: "tool_call_end", toolCall: { id, name, argumentsJson }, toolCallId: id },
        { type: "finish", finishReason: "tool_calls" },
      ],
    };
  },

  /** An HTTP failure, e.g. a 429 with an optional Retry-After hint. */
  httpError(status: number, message = `HTTP ${status}`, retryAfterMs?: number): FixtureResponse {
    return {
      kind: "error",
      error: new ProviderHttpError(status, message, {
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      }),
    };
  },

  /** An arbitrary error (network failure, parse error, ...). */
  error(err: unknown): FixtureResponse {
    return { kind: "error", error: err };
  },
} as const;

/**
 * Deterministic scripted provider for tests. Each complete() call consumes
 * the next scripted response; every request is recorded for assertions.
 * When the script is exhausted, complete() throws.
 */
export class FixtureProvider implements ModelProvider {
  readonly kind = "fixture" as const;
  readonly requests: CompletionRequest[] = [];
  private readonly queue: FixtureResponse[];
  private readonly models: string[];

  constructor(script: FixtureResponse[], options?: { models?: string[] }) {
    this.queue = [...script];
    this.models = options?.models ?? ["fixture-model"];
  }

  listModels(): Promise<string[]> {
    return Promise.resolve([...this.models]);
  }

  /** How many scripted responses remain. */
  get remaining(): number {
    return this.queue.length;
  }

  async *complete(request: CompletionRequest): AsyncGenerator<ModelStreamChunk> {
    this.requests.push(request);
    const next = this.queue.shift();
    if (next === undefined) {
      throw new Error(`FixtureProvider: script exhausted after ${this.requests.length} request(s)`);
    }
    if (next.kind === "error") throw next.error;
    for (const chunk of next.chunks) yield chunk;
  }
}
