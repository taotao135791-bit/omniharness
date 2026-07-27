import {
  DEFAULT_CAPABILITIES,
  type ModelDefinition,
  type ModelId,
  type ModelStreamChunk,
  type ProviderId,
} from "@omniharness/shared-types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelCapabilityRegistry } from "./capabilities.js";
import { BudgetExceededError, NoModelForRoleError, ProviderHttpError } from "./errors.js";
import { FixtureProvider, fixture } from "./fixture.js";
import { ModelRouter, type UsageRecord } from "./router.js";
import { textMessage, type ModelProvider, type RouterRequest } from "./types.js";

function makeModel(
  id: string,
  providerId: string,
  pricing?: { in: number; out: number },
): ModelDefinition {
  return {
    id: id as ModelId,
    providerId: providerId as ProviderId,
    remoteName: id,
    displayName: id,
    capabilities: { ...DEFAULT_CAPABILITIES },
    ...(pricing !== undefined
      ? { costPerMInputTokens: pricing.in, costPerMOutputTokens: pricing.out }
      : {}),
    enabled: true,
  };
}

function request(): RouterRequest {
  return { messages: [textMessage("user", "hello")] };
}

async function collect(stream: AsyncIterable<ModelStreamChunk>): Promise<ModelStreamChunk[]> {
  const chunks: ModelStreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

function makeRouter(options: {
  models: ModelDefinition[];
  providers: Map<string, ModelProvider>;
  router?: Partial<ConstructorParameters<typeof ModelRouter>[0]>;
}): ModelRouter {
  const registry = new ModelCapabilityRegistry();
  for (const m of options.models) registry.register(m);
  return new ModelRouter({
    registry,
    providers: options.providers,
    bindings: { primary: options.models[0]?.id as ModelId },
    ...options.router,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ModelRouter", () => {
  it("streams a completion and records usage with computed cost", async () => {
    const modelA = makeModel("a", "p1", { in: 1, out: 2 });
    const provider = new FixtureProvider([
      fixture.text(["hi ", "there"], { usage: { inputTokens: 1_000_000, outputTokens: 500_000 } }),
    ]);
    const records: UsageRecord[] = [];
    const router = makeRouter({
      models: [modelA],
      providers: new Map([["p1", provider]]),
      router: { recordUsage: (r) => records.push(r) },
    });

    const chunks = await collect(router.complete("primary", request()));
    expect(chunks.map((c) => c.type)).toEqual(["text_delta", "text_delta", "usage", "finish"]);
    expect(records).toHaveLength(1);
    expect(records[0]?.role).toBe("primary");
    // $1/M in * 1M + $2/M out * 0.5M = $2
    expect(records[0]?.usage.costUsd).toBe(2);
    expect(router.totals()).toEqual({ costUsd: 2, tokens: 1_500_000 });
  });

  it("falls back to the next model in the chain on persistent 429", async () => {
    const modelA = makeModel("a", "p1");
    const modelB = makeModel("b", "p2");
    const providerA = new FixtureProvider([fixture.httpError(429, "slow down")]);
    const providerB = new FixtureProvider([fixture.text("from B")]);
    const router = makeRouter({
      models: [modelA, modelB],
      providers: new Map([
        ["p1", providerA],
        ["p2", providerB],
      ]),
      router: {
        fallbacks: { primary: [modelB.id] },
        maxRetries: 0,
      },
    });

    const chunks = await collect(router.complete("primary", request()));
    expect(chunks.map((c) => c.type)).toEqual(["text_delta", "finish"]);
    expect(chunks[0]?.text).toBe("from B");
    expect(providerA.requests).toHaveLength(1);
    expect(providerB.requests).toHaveLength(1);
  });

  it("session overrides win over profile bindings", async () => {
    const modelA = makeModel("a", "p1");
    const modelB = makeModel("b", "p2");
    const providerA = new FixtureProvider([fixture.text("A")]);
    const providerB = new FixtureProvider([fixture.text("B")]);
    const router = makeRouter({
      models: [modelA, modelB],
      providers: new Map([
        ["p1", providerA],
        ["p2", providerB],
      ]),
      router: { sessionOverrides: { primary: modelB.id } },
    });
    const chunks = await collect(router.complete("primary", request()));
    expect(chunks[0]?.text).toBe("B");
    expect(providerA.requests).toHaveLength(0);
  });

  it("throws NoModelForRoleError for an unbound role", async () => {
    const modelA = makeModel("a", "p1");
    const router = makeRouter({ models: [modelA], providers: new Map([["p1", new FixtureProvider([])]]) });
    await expect(collect(router.complete("reviewer", request()))).rejects.toThrow(NoModelForRoleError);
  });

  it("does not retry non-retryable errors", async () => {
    const modelA = makeModel("a", "p1");
    const provider = new FixtureProvider([fixture.httpError(400, "bad request")]);
    const sleeps: number[] = [];
    const router = makeRouter({
      models: [modelA],
      providers: new Map([["p1", provider]]),
      router: { sleep: async (ms) => { sleeps.push(ms); } },
    });
    await expect(collect(router.complete("primary", request()))).rejects.toThrow(ProviderHttpError);
    expect(provider.requests).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });
});

describe("ModelRouter retry/backoff (fake timers)", () => {
  it("retries a 429 with exponential backoff + jitter, then succeeds", async () => {
    vi.useFakeTimers();
    const modelA = makeModel("a", "p1");
    const provider = new FixtureProvider([
      fixture.httpError(429),
      fixture.text("recovered"),
    ]);
    const router = makeRouter({
      models: [modelA],
      providers: new Map([["p1", provider]]),
      router: { maxRetries: 1, baseDelayMs: 1000, random: () => 0.5 },
    });

    const done = collect(router.complete("primary", request()));
    // delay = floor(500 + 0.5 * 500) = 750ms
    await vi.advanceTimersByTimeAsync(749);
    expect(provider.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    const chunks = await done;
    expect(provider.requests).toHaveLength(2);
    expect(chunks[0]?.text).toBe("recovered");
  });

  it("honors Retry-After over computed backoff", async () => {
    vi.useFakeTimers();
    const modelA = makeModel("a", "p1");
    const provider = new FixtureProvider([
      fixture.httpError(429, "rate limited", 5000),
      fixture.text("after wait"),
    ]);
    const router = makeRouter({
      models: [modelA],
      providers: new Map([["p1", provider]]),
      router: { maxRetries: 1, baseDelayMs: 100, random: () => 0 },
    });

    const done = collect(router.complete("primary", request()));
    await vi.advanceTimersByTimeAsync(4999);
    expect(provider.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    const chunks = await done;
    expect(chunks[0]?.text).toBe("after wait");
  });

  it("backs off exponentially across multiple retries on transient 5xx", async () => {
    vi.useFakeTimers();
    const modelA = makeModel("a", "p1");
    const provider = new FixtureProvider([
      fixture.httpError(503),
      fixture.httpError(502),
      fixture.text("ok"),
    ]);
    const router = makeRouter({
      models: [modelA],
      providers: new Map([["p1", provider]]),
      router: { maxRetries: 2, baseDelayMs: 1000, random: () => 0 },
    });

    const done = collect(router.complete("primary", request()));
    // attempt 0: 500ms; attempt 1: 1000ms (random=0 → delay = backoff/2)
    await vi.advanceTimersByTimeAsync(499);
    expect(provider.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(provider.requests).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(999);
    expect(provider.requests).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    const chunks = await done;
    expect(provider.requests).toHaveLength(3);
    expect(chunks[0]?.text).toBe("ok");
  });
});

describe("ModelRouter budget", () => {
  it("throws BudgetExceededError once the token budget is spent", async () => {
    const modelA = makeModel("a", "p1");
    const provider = new FixtureProvider([
      fixture.text("first", { usage: { inputTokens: 100, outputTokens: 50 } }),
      fixture.text("second"),
    ]);
    const router = makeRouter({
      models: [modelA],
      providers: new Map([["p1", provider]]),
      router: { budget: { maxTokens: 150 } },
    });

    await collect(router.complete("primary", request()));
    expect(router.totals().tokens).toBe(150);
    await expect(collect(router.complete("primary", request()))).rejects.toThrow(BudgetExceededError);
    // The blocked call never reached the provider.
    expect(provider.requests).toHaveLength(1);
  });

  it("throws BudgetExceededError once the cost budget is spent", async () => {
    const modelA = makeModel("a", "p1", { in: 10, out: 10 });
    const provider = new FixtureProvider([
      fixture.text("first", { usage: { inputTokens: 100_000, outputTokens: 100_000 } }),
    ]);
    const router = makeRouter({
      models: [modelA],
      providers: new Map([["p1", provider]]),
      router: { budget: { maxCostUsd: 2 } },
    });
    await collect(router.complete("primary", request()));
    expect(router.totals().costUsd).toBe(2);
    const err = await collect(router.complete("primary", request())).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect((err as BudgetExceededError).kind).toBe("cost");
  });
});

describe("ModelRouter health checks", () => {
  it("probes listModels and caches the result", async () => {
    let probes = 0;
    const provider: ModelProvider = {
      kind: "fixture",
      listModels: () => {
        probes += 1;
        return Promise.resolve(["m1"]);
      },
      complete: () => {
        throw new Error("not used");
      },
    };
    const modelA = makeModel("a", "p1");
    const router = makeRouter({
      models: [modelA],
      providers: new Map([["p1", provider]]),
      router: { healthCacheTtlMs: 60_000 },
    });

    const first = await router.checkHealth("p1");
    expect(first).toMatchObject({ providerId: "p1", ok: true });
    const second = await router.checkHealth("p1");
    expect(probes).toBe(1); // cached
    expect(second).toEqual(first);

    const missing = await router.checkHealth("nope");
    expect(missing.ok).toBe(false);
    expect(missing.error).toMatch(/not registered/);
  });
});
