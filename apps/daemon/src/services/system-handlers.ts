import fs from "node:fs";
import type { OmniDatabase } from "@omniharness/session-store";
import type { EventBus } from "../event-bus.js";
import { RpcError } from "../rpc-server.js";
import { ErrorCodes, type DiagnosticsReport } from "@omniharness/agent-protocol";
import type { Tracer } from "@omniharness/observability";
import { createProviderFromConfig, PROVIDER_PRESETS } from "@omniharness/model-gateway";
import type { SecretStore } from "@omniharness/secret-store";
import { nanoid } from "./id.js";
import type { ProviderConfig, ProviderKind } from "@omniharness/shared-types";

interface SystemDeps {
  db: OmniDatabase;
  bus: EventBus;
  tracer: Tracer;
  secrets: SecretStore;
  dataDir: string;
  version: string;
  startedAt: number;
}

/** System, provider, model, settings, usage handlers. */
export function registerSystemHandlers(
  register: (name: string, handler: (params: never) => unknown) => void,
  deps: SystemDeps,
): void {
  const { db, secrets } = deps;

  register("system.ping", () => ({
    ok: true as const,
    version: deps.version,
    uptimeMs: Date.now() - deps.startedAt,
  }));

  register("system.diagnostics", async (): Promise<DiagnosticsReport> => {
    const checks: DiagnosticsReport["checks"] = [];
    const integrityRows = db.integrityCheck();
    const integrityOk = integrityRows.length === 1 && integrityRows[0] === "ok";
    checks.push({ name: "database integrity", ok: integrityOk, detail: integrityRows.join("; ") });
    let secretsOk = true;
    let secretsDetail = "available";
    try {
      await secrets.list();
    } catch (err) {
      secretsOk = false;
      secretsDetail = err instanceof Error ? err.message : "unavailable";
    }
    checks.push({ name: "secret store", ok: secretsOk, detail: secretsDetail });
    let dirWritable = true;
    try {
      fs.accessSync(deps.dataDir, fs.constants.W_OK);
    } catch {
      dirWritable = false;
    }
    checks.push({ name: "data dir writable", ok: dirWritable, detail: deps.dataDir });
    checks.push({
      name: "event log",
      ok: true,
      detail: `${db.events.count()} events, latest seq ${db.events.latestSeq()}`,
    });
    return {
      ok: checks.every((c) => c.ok),
      checks,
      platform: { os: process.platform, arch: process.arch, node: process.version },
      dataDir: deps.dataDir,
      dbSizeBytes: fs.existsSync((db as unknown as { path?: string }).path ?? "") ? 0 : 0,
      eventLogSize: db.events.count(),
    };
  });

  register("events.since", (params: { seq: number; limit?: number }) => {
    const { events, latestSeq } = deps.bus.since(params.seq, params.limit ?? 1000);
    return { events, latestSeq };
  });

  // ── providers ────────────────────────────────────────────────────────────
  register("provider.list", () => ({ providers: db.providers.list() }));

  register(
    "provider.add",
    async (params: {
      kind: ProviderKind;
      displayName: string;
      baseUrl?: string;
      apiKey?: string;
      options?: Record<string, string>;
    }) => {
      const preset = PROVIDER_PRESETS.find((p) => p.kind === params.kind);
      const id = nanoid("prov") as ProviderConfig["id"];
      let apiKeyRef: string | undefined;
      if (params.apiKey) {
        apiKeyRef = `provider:${id}:apiKey`;
        await secrets.set(apiKeyRef, params.apiKey);
      }
      const provider: ProviderConfig = {
        id,
        kind: params.kind,
        displayName: params.displayName,
        enabled: true,
        rateLimitRpm: 0,
        timeoutMs: 120_000,
        maxRetries: 3,
        ...((params.baseUrl ?? preset?.baseUrl)
          ? { baseUrl: params.baseUrl ?? preset!.baseUrl! }
          : {}),
        ...(apiKeyRef ? { apiKeyRef } : {}),
        ...(params.options ? { options: params.options } : {}),
      };
      db.providers.put(provider);
      return { provider };
    },
  );

  register("provider.remove", async (params: { providerId: string }) => {
    const provider = db.providers.get(params.providerId as ProviderConfig["id"]);
    if (!provider) throw new RpcError(ErrorCodes.NOT_FOUND, "provider not found");
    if (provider.apiKeyRef) await secrets.delete(provider.apiKeyRef);
    db.providers.delete(provider.id);
    return { ok: true as const };
  });

  register("provider.test", async (params: { providerId: string }) => {
    const provider = db.providers.get(params.providerId as ProviderConfig["id"]);
    if (!provider) throw new RpcError(ErrorCodes.NOT_FOUND, "provider not found");
    const started = Date.now();
    try {
      const p = await createProviderFromConfig(provider, secrets);
      const models = await p.listModels();
      return { ok: true, latencyMs: Date.now() - started, models };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  register("model.list", (params: { providerId?: string }) => ({
    models: params.providerId
      ? db.models.listByProvider(params.providerId as ProviderConfig["id"])
      : db.providers.list().flatMap((p) => db.models.listByProvider(p.id)),
  }));

  // ── settings (scoped key/value; schema validation happens in config-schema) ──
  register("settings.get", (params: { scope?: string; scopeId?: string }) => {
    const entries = db.settings.list((params.scope ?? "global") as never, params.scopeId ?? "");
    const settings: Record<string, unknown> = {};
    for (const e of entries) settings[e.key] = e.value;
    return { settings };
  });

  register(
    "settings.set",
    (params: { key: string; value: unknown; scope?: string; scopeId?: string }) => {
      db.settings.set(
        (params.scope ?? "global") as never,
        params.scopeId ?? "",
        params.key,
        params.value,
      );
      return { ok: true as const };
    },
  );

  // ── usage ────────────────────────────────────────────────────────────────
  register(
    "usage.summary",
    (params: { since?: string; groupBy?: "model" | "project" | "agent" | "automation" }) => {
      const dim = params.groupBy ?? "model";
      const rows =
        dim === "model"
          ? db.modelUsage.aggregateByModel(params.since)
          : dim === "project"
            ? db.modelUsage.aggregateByProject(params.since)
            : dim === "agent"
              ? db.modelUsage.aggregateByAgent(params.since)
              : db.modelUsage.aggregateByAutomation(params.since);
      return {
        usage: rows.map((r) => ({
          key: r.key ?? "(unattributed)",
          usage: r.usage,
          requests: r.samples,
        })),
      };
    },
  );
}
