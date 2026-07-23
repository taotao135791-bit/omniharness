import type { DatabaseSync } from "node:sqlite";
import type {
  IsoTimestamp,
  ModelCapabilities,
  ModelDefinition,
  ModelId,
  ProviderConfig,
  ProviderId,
  TokenUsage,
} from "@omniharness/shared-types";
import { allRows, bit, bool, getRow, jparse, jstr, num, numOrNull } from "../helpers.js";
import type { ModelUsageRecord, UsageAggregateRow, UsageDimension } from "../types.js";

interface ProviderRow {
  id: string;
  kind: string;
  display_name: string;
  base_url: string | null;
  api_key_ref: string | null;
  region: string | null;
  enabled: number;
  rate_limit_rpm: number;
  timeout_ms: number;
  max_retries: number;
  extra_headers: string | null;
  options: string | null;
}

function rowToProvider(r: ProviderRow): ProviderConfig {
  const provider: ProviderConfig = {
    id: r.id as ProviderId,
    kind: r.kind as ProviderConfig["kind"],
    displayName: r.display_name,
    enabled: bool(r.enabled),
    rateLimitRpm: num(r.rate_limit_rpm),
    timeoutMs: num(r.timeout_ms),
    maxRetries: num(r.max_retries),
  };
  if (r.base_url !== null) provider.baseUrl = r.base_url;
  if (r.api_key_ref !== null) provider.apiKeyRef = r.api_key_ref;
  if (r.region !== null) provider.region = r.region;
  if (r.extra_headers !== null) {
    provider.extraHeaders = jparse<Record<string, string>>(r.extra_headers, {});
  }
  if (r.options !== null) provider.options = jparse<Record<string, string>>(r.options, {});
  return provider;
}

export class ProvidersRepo {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  put(provider: ProviderConfig): void {
    this.db
      .prepare(
        `INSERT INTO providers
           (id, kind, display_name, base_url, api_key_ref, region, enabled, rate_limit_rpm, timeout_ms, max_retries, extra_headers, options)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           kind = excluded.kind, display_name = excluded.display_name, base_url = excluded.base_url,
           api_key_ref = excluded.api_key_ref, region = excluded.region, enabled = excluded.enabled,
           rate_limit_rpm = excluded.rate_limit_rpm, timeout_ms = excluded.timeout_ms,
           max_retries = excluded.max_retries, extra_headers = excluded.extra_headers,
           options = excluded.options`,
      )
      .run(
        provider.id,
        provider.kind,
        provider.displayName,
        provider.baseUrl ?? null,
        provider.apiKeyRef ?? null,
        provider.region ?? null,
        bit(provider.enabled),
        provider.rateLimitRpm,
        provider.timeoutMs,
        provider.maxRetries,
        provider.extraHeaders === undefined ? null : jstr(provider.extraHeaders),
        provider.options === undefined ? null : jstr(provider.options),
      );
  }

  get(id: ProviderId): ProviderConfig | undefined {
    const row = getRow<ProviderRow>(this.db.prepare("SELECT * FROM providers WHERE id = ?"), id);
    return row === undefined ? undefined : rowToProvider(row);
  }

  list(enabledOnly = false): ProviderConfig[] {
    const rows = enabledOnly
      ? allRows<ProviderRow>(
          this.db.prepare("SELECT * FROM providers WHERE enabled = 1 ORDER BY display_name, id"),
        )
      : allRows<ProviderRow>(this.db.prepare("SELECT * FROM providers ORDER BY display_name, id"));
    return rows.map(rowToProvider);
  }

  delete(id: ProviderId): boolean {
    return this.db.prepare("DELETE FROM providers WHERE id = ?").run(id).changes > 0;
  }
}

interface ModelRow {
  id: string;
  provider_id: string;
  remote_name: string;
  display_name: string;
  capabilities: string;
  cost_per_m_input_tokens: number | null;
  cost_per_m_output_tokens: number | null;
  enabled: number;
}

function rowToModel(r: ModelRow): ModelDefinition {
  const model: ModelDefinition = {
    id: r.id as ModelId,
    providerId: r.provider_id as ProviderId,
    remoteName: r.remote_name,
    displayName: r.display_name,
    capabilities: jparse<ModelCapabilities>(r.capabilities, {} as ModelCapabilities),
    enabled: bool(r.enabled),
  };
  const cin = numOrNull(r.cost_per_m_input_tokens);
  const cout = numOrNull(r.cost_per_m_output_tokens);
  if (cin !== null) model.costPerMInputTokens = cin;
  if (cout !== null) model.costPerMOutputTokens = cout;
  return model;
}

export class ModelsRepo {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  put(model: ModelDefinition): void {
    this.db
      .prepare(
        `INSERT INTO models
           (id, provider_id, remote_name, display_name, capabilities, cost_per_m_input_tokens, cost_per_m_output_tokens, enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           provider_id = excluded.provider_id, remote_name = excluded.remote_name,
           display_name = excluded.display_name, capabilities = excluded.capabilities,
           cost_per_m_input_tokens = excluded.cost_per_m_input_tokens,
           cost_per_m_output_tokens = excluded.cost_per_m_output_tokens,
           enabled = excluded.enabled`,
      )
      .run(
        model.id,
        model.providerId,
        model.remoteName,
        model.displayName,
        jstr(model.capabilities),
        model.costPerMInputTokens ?? null,
        model.costPerMOutputTokens ?? null,
        bit(model.enabled),
      );
  }

  get(id: ModelId): ModelDefinition | undefined {
    const row = getRow<ModelRow>(this.db.prepare("SELECT * FROM models WHERE id = ?"), id);
    return row === undefined ? undefined : rowToModel(row);
  }

  listByProvider(providerId: ProviderId, enabledOnly = false): ModelDefinition[] {
    const rows = enabledOnly
      ? allRows<ModelRow>(
          this.db.prepare(
            "SELECT * FROM models WHERE provider_id = ? AND enabled = 1 ORDER BY display_name, id",
          ),
          providerId,
        )
      : allRows<ModelRow>(
          this.db.prepare("SELECT * FROM models WHERE provider_id = ? ORDER BY display_name, id"),
          providerId,
        );
    return rows.map(rowToModel);
  }

  delete(id: ModelId): boolean {
    return this.db.prepare("DELETE FROM models WHERE id = ?").run(id).changes > 0;
  }
}

interface UsageRow {
  id: number;
  at: string;
  model_id: string;
  profile_id: string | null;
  project_id: string | null;
  session_id: string | null;
  agent_id: string | null;
  automation_id: string | null;
  usage: string;
}

function rowToUsage(r: UsageRow): ModelUsageRecord {
  return {
    id: num(r.id),
    at: r.at,
    modelId: r.model_id as ModelId,
    profileId: r.profile_id as ModelUsageRecord["profileId"],
    projectId: r.project_id as ModelUsageRecord["projectId"],
    sessionId: r.session_id as ModelUsageRecord["sessionId"],
    agentId: r.agent_id as ModelUsageRecord["agentId"],
    automationId: r.automation_id as ModelUsageRecord["automationId"],
    usage: jparse<TokenUsage>(r.usage, {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    }),
  };
}

const DIMENSION_COLUMN: Record<UsageDimension, string> = {
  model: "model_id",
  project: "project_id",
  agent: "agent_id",
  automation: "automation_id",
};

const ZERO_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

export class ModelUsageRepo {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** Record a usage sample; returns the row id. All attribution fields optional. */
  record(sample: Omit<ModelUsageRecord, "id">): number {
    const res = this.db
      .prepare(
        `INSERT INTO model_usage (at, model_id, profile_id, project_id, session_id, agent_id, automation_id, usage)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sample.at,
        sample.modelId,
        sample.profileId,
        sample.projectId,
        sample.sessionId,
        sample.agentId,
        sample.automationId,
        jstr(sample.usage),
      );
    return Number(res.lastInsertRowid);
  }

  get(id: number): ModelUsageRecord | undefined {
    const row = getRow<UsageRow>(this.db.prepare("SELECT * FROM model_usage WHERE id = ?"), id);
    return row === undefined ? undefined : rowToUsage(row);
  }

  listByModel(modelId: ModelId, since?: IsoTimestamp): ModelUsageRecord[] {
    const rows =
      since === undefined
        ? allRows<UsageRow>(
            this.db.prepare("SELECT * FROM model_usage WHERE model_id = ? ORDER BY at, id"),
            modelId,
          )
        : allRows<UsageRow>(
            this.db.prepare("SELECT * FROM model_usage WHERE model_id = ? AND at >= ? ORDER BY at, id"),
            modelId,
            since,
          );
    return rows.map(rowToUsage);
  }

  /**
   * Sum token usage grouped by a dimension ("model" | "project" | "agent" |
   * "automation"), optionally only samples at or after `since`.
   * Rows with NULL attribution group under key `null`.
   */
  aggregateBy(dimension: UsageDimension, since?: IsoTimestamp): UsageAggregateRow[] {
    const col = DIMENSION_COLUMN[dimension];
    const sql = `
      SELECT ${col} AS k,
             COUNT(*) AS samples,
             COALESCE(SUM(CAST(json_extract(usage, '$.inputTokens') AS INTEGER)), 0)  AS input_tokens,
             COALESCE(SUM(CAST(json_extract(usage, '$.outputTokens') AS INTEGER)), 0) AS output_tokens,
             COALESCE(SUM(CAST(json_extract(usage, '$.cacheReadTokens') AS INTEGER)), 0)  AS cache_read,
             COALESCE(SUM(CAST(json_extract(usage, '$.cacheWriteTokens') AS INTEGER)), 0) AS cache_write,
             COALESCE(SUM(CAST(json_extract(usage, '$.costUsd') AS REAL)), 0) AS cost_usd,
             MAX(json_extract(usage, '$.costUsd') IS NOT NULL) AS has_cost
      FROM model_usage
      ${since === undefined ? "" : "WHERE at >= ?"}
      GROUP BY ${col}
      ORDER BY input_tokens DESC`;
    const params = since === undefined ? [] : [since];
    interface AggRow {
      k: string | null;
      samples: number;
      input_tokens: number;
      output_tokens: number;
      cache_read: number;
      cache_write: number;
      cost_usd: number;
      has_cost: number;
    }
    const stmt = this.db.prepare(sql);
    const rows = allRows<AggRow>(stmt, ...params);
    return rows.map((r) => {
      const usage: TokenUsage = {
        inputTokens: num(r.input_tokens),
        outputTokens: num(r.output_tokens),
        cacheReadTokens: num(r.cache_read),
        cacheWriteTokens: num(r.cache_write),
      };
      if (num(r.has_cost) === 1) usage.costUsd = num(r.cost_usd);
      return { key: r.k, usage, samples: num(r.samples) };
    });
  }

  aggregateByModel(since?: IsoTimestamp): UsageAggregateRow[] {
    return this.aggregateBy("model", since);
  }

  aggregateByProject(since?: IsoTimestamp): UsageAggregateRow[] {
    return this.aggregateBy("project", since);
  }

  aggregateByAgent(since?: IsoTimestamp): UsageAggregateRow[] {
    return this.aggregateBy("agent", since);
  }

  aggregateByAutomation(since?: IsoTimestamp): UsageAggregateRow[] {
    return this.aggregateBy("automation", since);
  }

  /** Grand total across all samples (optionally since a timestamp). */
  total(since?: IsoTimestamp): TokenUsage {
    const rows = this.aggregateBy("model", since);
    const total: TokenUsage = { ...ZERO_USAGE };
    let cost = 0;
    let hasCost = false;
    for (const row of rows) {
      total.inputTokens += row.usage.inputTokens;
      total.outputTokens += row.usage.outputTokens;
      total.cacheReadTokens += row.usage.cacheReadTokens;
      total.cacheWriteTokens += row.usage.cacheWriteTokens;
      if (row.usage.costUsd !== undefined) {
        cost += row.usage.costUsd;
        hasCost = true;
      }
    }
    if (hasCost) total.costUsd = cost;
    return total;
  }

  deleteBefore(before: IsoTimestamp): number {
    return Number(this.db.prepare("DELETE FROM model_usage WHERE at < ?").run(before).changes);
  }
}
