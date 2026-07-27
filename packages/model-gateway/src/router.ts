import type {
  IsoTimestamp,
  ModelDefinition,
  ModelId,
  ModelRole,
  ModelStreamChunk,
  ProviderId,
  RoleModelBinding,
  TokenUsage,
} from "@omniharness/shared-types";
import { nowIso } from "@omniharness/shared-types";
import type { ModelCapabilityRegistry } from "./capabilities.js";
import {
  BudgetExceededError,
  NoModelForRoleError,
  isRateLimitError,
  isRetryableProviderError,
} from "./errors.js";
import type { ModelProvider, RouterRequest } from "./types.js";

export interface UsageRecord {
  role: ModelRole;
  modelId: ModelId;
  providerId: ProviderId;
  usage: TokenUsage;
  at: IsoTimestamp;
}

/** Called once per successful completion with its final token usage. */
export type UsageRecorder = (record: UsageRecord) => void;

export interface RouterBudget {
  /** USD cap; 0/undefined = unlimited. */
  maxCostUsd?: number;
  /** Total token cap (input + output); 0/undefined = unlimited. */
  maxTokens?: number;
}

export interface ModelRouterOptions {
  registry: ModelCapabilityRegistry;
  /** Providers keyed by ProviderId. */
  providers: ReadonlyMap<string, ModelProvider>;
  /** Profile-level role → model bindings. */
  bindings: RoleModelBinding;
  /** Ordered fallback chains per role (appended after the bound model). */
  fallbacks?: Partial<Record<ModelRole, ModelId[]>>;
  /** Session-level bindings; win over profile bindings. */
  sessionOverrides?: RoleModelBinding;
  recordUsage?: UsageRecorder;
  budget?: RouterBudget;
  /** Retries per model before falling through to the next model. Default 3. */
  maxRetries?: number;
  /** Base backoff delay in ms. Default 500. */
  baseDelayMs?: number;
  /** Backoff cap in ms. Default 30_000. */
  maxDelayMs?: number;
  /** Fall through to the next model after retries are exhausted. Default true. */
  fallbackOnRateLimit?: boolean;
  /** Health probe cache TTL in ms. Default 60_000. */
  healthCacheTtlMs?: number;
  /** Injectable RNG for backoff jitter (tests). */
  random?: () => number;
  /** Injectable sleep (tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Called when the router falls through from one model to the next in a chain. */
  onModelFallback?: (
    role: ModelRole,
    fromModelId: ModelId,
    toModelId: ModelId,
    reason: string,
  ) => void;
}

export interface ProviderHealth {
  providerId: string;
  ok: boolean;
  latencyMs: number;
  error?: string;
  checkedAt: number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ModelRouter {
  private readonly registry: ModelCapabilityRegistry;
  private readonly providers: ReadonlyMap<string, ModelProvider>;
  private readonly bindings: RoleModelBinding;
  private readonly fallbacks: Partial<Record<ModelRole, ModelId[]>>;
  private sessionOverrides: RoleModelBinding;
  private readonly recordUsage?: UsageRecorder;
  private readonly budget?: RouterBudget;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly fallbackOnRateLimit: boolean;
  private readonly onModelFallback: ModelRouterOptions["onModelFallback"];
  private readonly healthCacheTtlMs: number;
  private readonly random: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  private readonly healthCache = new Map<string, ProviderHealth>();
  private spentCostUsd = 0;
  private spentTokens = 0;

  constructor(options: ModelRouterOptions) {
    this.registry = options.registry;
    this.providers = options.providers;
    this.bindings = options.bindings;
    this.fallbacks = options.fallbacks ?? {};
    this.sessionOverrides = options.sessionOverrides ?? {};
    if (options.recordUsage !== undefined) this.recordUsage = options.recordUsage;
    if (options.budget !== undefined) this.budget = options.budget;
    this.maxRetries = options.maxRetries ?? 3;
    this.baseDelayMs = options.baseDelayMs ?? 500;
    this.maxDelayMs = options.maxDelayMs ?? 30_000;
    this.fallbackOnRateLimit = options.fallbackOnRateLimit ?? true;
    this.onModelFallback = options.onModelFallback;
    this.healthCacheTtlMs = options.healthCacheTtlMs ?? 60_000;
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? defaultSleep;
  }

  setSessionOverrides(overrides: RoleModelBinding): void {
    this.sessionOverrides = overrides;
  }

  /** Cumulative spend since router construction. */
  totals(): { costUsd: number; tokens: number } {
    return { costUsd: this.spentCostUsd, tokens: this.spentTokens };
  }

  /** Ordered candidate models for a role: bound model first, then fallbacks. */
  resolveChain(role: ModelRole): ModelDefinition[] {
    const bound = this.sessionOverrides[role] ?? this.bindings[role];
    const ids: ModelId[] = [];
    if (bound !== undefined) ids.push(bound);
    for (const id of this.fallbacks[role] ?? []) {
      if (!ids.includes(id)) ids.push(id);
    }
    return ids.flatMap((id) => {
      const def = this.registry.get(id);
      return def !== undefined && def.enabled ? [def] : [];
    });
  }

  private retryDelayMs(err: unknown, attempt: number): number {
    if (isRateLimitError(err) && err.retryAfterMs !== undefined) return err.retryAfterMs;
    const backoff = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** attempt);
    return Math.floor(backoff / 2 + this.random() * (backoff / 2));
  }

  private enforceBudget(): void {
    if (
      this.budget?.maxCostUsd !== undefined &&
      this.budget.maxCostUsd > 0 &&
      this.spentCostUsd >= this.budget.maxCostUsd
    ) {
      throw new BudgetExceededError("cost", this.spentCostUsd, this.budget.maxCostUsd);
    }
    if (
      this.budget?.maxTokens !== undefined &&
      this.budget.maxTokens > 0 &&
      this.spentTokens >= this.budget.maxTokens
    ) {
      throw new BudgetExceededError("tokens", this.spentTokens, this.budget.maxTokens);
    }
  }

  private withCost(model: ModelDefinition, usage: TokenUsage): TokenUsage {
    if (usage.costUsd !== undefined) return usage;
    const inCost = model.costPerMInputTokens;
    const outCost = model.costPerMOutputTokens;
    if (inCost === undefined && outCost === undefined) return usage;
    const costUsd =
      (usage.inputTokens / 1_000_000) * (inCost ?? 0) +
      (usage.outputTokens / 1_000_000) * (outCost ?? 0);
    return { ...usage, costUsd };
  }

  /**
   * Resolves the model chain for the role and streams a completion: retries
   * 429/transient-5xx with exponential backoff + jitter (honoring
   * Retry-After), falls through to the next model when retries are
   * exhausted, records usage, and enforces the configured budget.
   *
   * If a provider fails after chunks were already streamed, the error cannot
   * be retried without duplicating output, so an error chunk is yielded and
   * the stream ends.
   */
  async *complete(role: ModelRole, request: RouterRequest): AsyncGenerator<ModelStreamChunk> {
    this.enforceBudget();
    const chain = this.resolveChain(role);
    if (chain.length === 0) throw new NoModelForRoleError(role, "no model bound or registered");

    let lastError: unknown;
    for (const model of chain) {
      const provider = this.providers.get(model.providerId);
      if (provider === undefined) {
        lastError = new Error(`No provider registered for providerId "${model.providerId}"`);
        continue;
      }
      for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
        let yieldedAny = false;
        let usage: TokenUsage | undefined;
        try {
          for await (const chunk of provider.complete({ ...request, model })) {
            if (chunk.type === "usage" && chunk.usage !== undefined) usage = chunk.usage;
            yieldedAny = true;
            yield chunk;
          }
          if (usage !== undefined) {
            const costed = this.withCost(model, usage);
            this.spentCostUsd += costed.costUsd ?? 0;
            this.spentTokens += costed.inputTokens + costed.outputTokens;
            this.recordUsage?.({
              role,
              modelId: model.id,
              providerId: model.providerId,
              usage: costed,
              at: nowIso(),
            });
          }
          return;
        } catch (err) {
          lastError = err;
          if (yieldedAny) {
            // Mid-stream failure: retrying would duplicate emitted output.
            yield {
              type: "error",
              error: `Stream from "${model.id}" failed mid-completion: ${err instanceof Error ? err.message : String(err)}`,
            };
            return;
          }
          if (isRetryableProviderError(err) && attempt < this.maxRetries) {
            await this.sleep(this.retryDelayMs(err, attempt));
            continue;
          }
          if (isRetryableProviderError(err) && this.fallbackOnRateLimit) {
            const next = chain[chain.indexOf(model) + 1];
            if (next !== undefined) {
              this.onModelFallback?.(
                role,
                model.id,
                next.id,
                err instanceof Error ? err.message : String(err),
              );
            }
            break; // next model
          }
          throw err;
        }
      }
    }
    if (lastError !== undefined) throw lastError;
    throw new NoModelForRoleError(role, "all models in the chain were unavailable");
  }

  /** Latency probe via listModels(); results are cached for healthCacheTtlMs. */
  async checkHealth(providerId: string): Promise<ProviderHealth> {
    const cached = this.healthCache.get(providerId);
    const now = Date.now();
    if (cached !== undefined && now - cached.checkedAt < this.healthCacheTtlMs) return cached;

    const provider = this.providers.get(providerId);
    let health: ProviderHealth;
    if (provider === undefined) {
      health = {
        providerId,
        ok: false,
        latencyMs: 0,
        error: "provider not registered",
        checkedAt: now,
      };
    } else {
      const started = Date.now();
      try {
        await provider.listModels();
        health = { providerId, ok: true, latencyMs: Date.now() - started, checkedAt: now };
      } catch (err) {
        health = {
          providerId,
          ok: false,
          latencyMs: Date.now() - started,
          error: err instanceof Error ? err.message : String(err),
          checkedAt: now,
        };
      }
    }
    this.healthCache.set(providerId, health);
    return health;
  }
}
