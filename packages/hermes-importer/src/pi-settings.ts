import { cpSync, existsSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ModelCapabilities,
  ModelDefinition,
  ModelId,
  ProviderConfig,
  ProviderId,
  ProviderKind,
} from "@omniharness/shared-types";
import { DEFAULT_CAPABILITIES, nowIso } from "@omniharness/shared-types";
import type { OmniDatabase, SettingsScope } from "@omniharness/session-store";
import { ImportStateTracker } from "./import-state.js";
import {
  asNumber,
  asRecord,
  asString,
  asStringArray,
  errMessage,
  readJsonFile,
} from "./json-utils.js";
import {
  type ImportError,
  type ImportOptions,
  type ImportReport,
  ImportReportBuilder,
  type ImportSkip,
} from "./report.js";
import type { SecretStore } from "./secret-store.js";

/**
 * Importer for a Pi agent directory (`~/.pi/agent`, optionally plus a project
 * `.pi/` directory):
 *
 * - `settings.json` — known keys are mapped onto OmniHarness SETTINGS_SCHEMA
 *   keys (see {@link PI_SETTINGS_KEY_MAP}); every other key is listed in
 *   `unmappedKeys`. Mapped values are written to the settings table.
 * - `skills/`, `prompts/`, `themes/` — copied into
 *   `<dataDir>/pi/<scope>/<name>/` with a `_omni-provenance.json` marker
 *   (`provenance: "imported"`).
 * - `models.json` — custom providers/models become ProviderConfig /
 *   ModelDefinition rows. Literal `apiKey` values go to the SecretStore, only
 *   refs are persisted.
 * - `auth.json` — credentials are written ONLY into the injected SecretStore
 *   (api keys, env values, OAuth payloads). Nothing secret is ever written to
 *   the database or JSON output; the report carries counts.
 */

export interface PiSettingsImportOptions extends ImportOptions {
  /** Pi agent dir (e.g. `~/.pi/agent`). */
  agentDir: string;
  /** Project root containing a `.pi/` directory (project settings win). */
  projectDir?: string;
  /** OmniHarness data dir that receives copied resource directories. */
  dataDir: string;
  db: OmniDatabase;
  /** Required for auth.json / literal apiKey import; without it secrets are skipped. */
  secretStore?: SecretStore;
  /**
   * Valid target settings keys (pass the keys of SETTINGS_SCHEMA from
   * `@omniharness/config-schema`). When provided, a mapping whose target is
   * not in this list is reported as an error instead of being written.
   */
  schemaKeys?: readonly string[];
  /** Settings scope for mapped keys. Defaults to global/global. */
  settingsScope?: SettingsScope;
  settingsScopeId?: string;
}

export interface PiSettingsImportReport extends ImportReport {
  /** Pi settings keys with no OmniHarness equivalent (explicitly not imported). */
  unmappedKeys: string[];
  /** Number of secrets written to the SecretStore. */
  secretsStored: number;
  /** Number of resource files copied into the data dir. */
  filesCopied: number;
}

interface KeyMapping {
  target: string;
  validate?: (value: unknown) => boolean;
  transform?: (value: unknown) => unknown;
}

const TUI_THEMES = new Set(["auto", "dark", "light", "mono"]);

/**
 * Known Pi settings keys → OmniHarness SETTINGS_SCHEMA keys. Nested Pi
 * objects are addressed with dotted keys one level deep (e.g. "retry.maxRetries").
 * Keys not listed here are reported as unmapped.
 */
export const PI_SETTINGS_KEY_MAP: Readonly<Record<string, KeyMapping>> = {
  defaultModel: {
    target: "models.defaultModelId",
    validate: (v) => typeof v === "string",
  },
  theme: {
    target: "tui.theme",
    validate: (v) => typeof v === "string" && TUI_THEMES.has(v),
  },
  externalEditor: {
    target: "tui.editorCommand",
    validate: (v) => typeof v === "string",
  },
  enableAnalytics: {
    target: "telemetry.anonymousUsage",
    validate: (v) => typeof v === "boolean",
  },
  "retry.maxRetries": {
    target: "models.maxRetries",
    validate: (v) => typeof v === "number",
  },
};

const RESOURCE_DIRS: ReadonlyArray<{ name: string; recursive: boolean }> = [
  { name: "skills", recursive: true },
  { name: "prompts", recursive: false },
  { name: "themes", recursive: false },
];

function apiToProviderKind(api: string | undefined): ProviderKind {
  switch (api) {
    case "anthropic-messages":
      return "anthropic";
    case "openai-completions":
    case "openai-responses":
    case "openai-codex-responses":
      return "openai";
    case "azure-openai-responses":
      return "azure-openai";
    case "google-generative-ai":
    case "google-vertex":
      return "google";
    case "bedrock-converse-stream":
      return "aws-bedrock";
    case "mistral-conversations":
      return "mistral";
    case "openrouter-images":
      return "openrouter";
    default:
      return "openai-compatible";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class PiSettingsReportBuilder extends ImportReportBuilder {
  readonly unmappedKeys: string[] = [];
  secretsStored = 0;
  filesCopied = 0;

  finishPi(): PiSettingsImportReport {
    const base = super.finish();
    return {
      ...base,
      unmappedKeys: this.unmappedKeys,
      secretsStored: this.secretsStored,
      filesCopied: this.filesCopied,
    };
  }
}

function importSettingsObject(
  settings: Record<string, unknown>,
  sourcePath: string,
  options: PiSettingsImportOptions,
  report: PiSettingsReportBuilder,
  schemaKeys: ReadonlySet<string> | undefined,
): void {
  const scope = options.settingsScope ?? "global";
  const scopeId = options.settingsScopeId ?? "global";

  // Flatten one level of nested objects so "retry": {maxRetries: n} is
  // addressable as "retry.maxRetries".
  const flat: Array<[string, unknown]> = [];
  for (const [key, value] of Object.entries(settings)) {
    flat.push([key, value]);
    if (isPlainObject(value)) {
      for (const [sub, subValue] of Object.entries(value)) {
        flat.push([`${key}.${sub}`, subValue]);
      }
    }
  }

  const seenTargets = new Set<string>();
  for (const [key, value] of flat) {
    const mapping = PI_SETTINGS_KEY_MAP[key];
    if (mapping === undefined) {
      // Only report top-level and one-deep keys that carry leaf values.
      if (!isPlainObject(value)) report.unmappedKeys.push(key);
      continue;
    }
    if (seenTargets.has(mapping.target)) continue;
    if (mapping.validate !== undefined && !mapping.validate(value)) {
      report.warn(
        `${sourcePath}: key "${key}" has an incompatible value for ${mapping.target}; not mapped`,
      );
      report.skip(key, `value incompatible with ${mapping.target}`);
      continue;
    }
    if (schemaKeys !== undefined && !schemaKeys.has(mapping.target)) {
      report.error(key, `mapped target "${mapping.target}" is not in the settings schema`);
      continue;
    }
    seenTargets.add(mapping.target);
    const out = mapping.transform === undefined ? value : mapping.transform(value);
    if (options.dryRun !== true) {
      options.db.settings.set(scope, scopeId, mapping.target, out);
    }
    report.imported();
  }
}

function copyResourceDir(
  srcDir: string,
  destDir: string,
  recursive: boolean,
  sourceLabel: string,
  options: PiSettingsImportOptions,
  report: PiSettingsReportBuilder,
  tracker: ImportStateTracker,
): void {
  if (!existsSync(srcDir)) return;
  if (tracker.has(srcDir)) {
    report.skip(srcDir, "already imported");
    return;
  }
  const entries = readdirSync(srcDir, { withFileTypes: true });
  const toCopy = recursive
    ? entries.filter((e) => !e.name.startsWith("."))
    : entries.filter((e) => e.isFile() && !e.name.startsWith("."));
  if (toCopy.length === 0) return;

  if (options.dryRun !== true) {
    mkdirSync(destDir, { recursive: true });
    for (const entry of toCopy) {
      cpSync(join(srcDir, entry.name), join(destDir, entry.name), { recursive: true });
    }
    writeFileSync(
      join(destDir, "_omni-provenance.json"),
      JSON.stringify(
        {
          provenance: "imported",
          source: "pi",
          sourceScope: sourceLabel,
          sourcePath: srcDir,
          importedAt: nowIso(),
        },
        null,
        2,
      ),
    );
    tracker.mark(srcDir, destDir);
  }
  report.filesCopied += toCopy.length;
  report.imported();
}

async function importModelsJson(
  path: string,
  options: PiSettingsImportOptions,
  report: PiSettingsReportBuilder,
  tracker: ImportStateTracker,
): Promise<void> {
  const result = readJsonFile(path);
  if (!result.ok) {
    if (existsSync(path)) report.error(path, result.error);
    return;
  }
  const root = asRecord(result.value);
  const providers = root === undefined ? undefined : asRecord(root["providers"]);
  if (providers === undefined) {
    report.error(path, 'models.json does not match the expected shape ({providers: {...}})');
    return;
  }

  for (const [name, rawProvider] of Object.entries(providers)) {
    const sourceKey = `models:${name}`;
    if (tracker.has(sourceKey)) {
      report.skip(sourceKey, "already imported");
      continue;
    }
    const rec = asRecord(rawProvider);
    if (rec === undefined) {
      report.error(sourceKey, "provider entry is not an object");
      continue;
    }
    const providerId = `prov_pi_${name}` as ProviderId;
    const provider: ProviderConfig = {
      id: providerId,
      kind: apiToProviderKind(asString(rec["api"])),
      displayName: asString(rec["name"]) ?? name,
      enabled: true,
      rateLimitRpm: 0,
      timeoutMs: 120_000,
      maxRetries: 3,
    };
    const baseUrl = asString(rec["baseUrl"]);
    if (baseUrl !== undefined) provider.baseUrl = baseUrl;
    const headers = asRecord(rec["headers"]);
    if (headers !== undefined) {
      const extraHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(headers)) {
        if (typeof v === "string") extraHeaders[k] = v;
      }
      provider.extraHeaders = extraHeaders;
    }

    const apiKey = asString(rec["apiKey"]);
    if (apiKey !== undefined) {
      if (apiKey.startsWith("$")) {
        // "$ENV_VAR" indirection: keep a non-secret env reference.
        provider.apiKeyRef = `env:${apiKey.slice(1)}`;
      } else if (apiKey.startsWith("!")) {
        report.warn(`${sourceKey}: apiKey uses a "!command" resolver; not imported`);
      } else if (options.secretStore !== undefined) {
        const ref = `provider:${providerId}:apiKey`;
        if (options.dryRun !== true) await options.secretStore.set(ref, apiKey);
        provider.apiKeyRef = ref;
        report.secretsStored += 1;
      } else {
        report.warn(`${sourceKey}: literal apiKey skipped (no SecretStore configured)`);
      }
    }

    const models: ModelDefinition[] = [];
    const rawModels = Array.isArray(rec["models"]) ? (rec["models"] as unknown[]) : [];
    for (const rawModel of rawModels) {
      const m = asRecord(rawModel);
      const remoteName = m === undefined ? undefined : asString(m["id"]);
      if (m === undefined || remoteName === undefined) {
        report.error(sourceKey, "model entry without an id; skipped");
        continue;
      }
      const input = asStringArray(m["input"]) ?? ["text"];
      const capabilities: ModelCapabilities = {
        ...DEFAULT_CAPABILITIES,
        vision: input.includes("image"),
        reasoningControl: m["reasoning"] === true,
        contextWindow: asNumber(m["contextWindow"]) ?? DEFAULT_CAPABILITIES.contextWindow,
        maxOutputTokens: asNumber(m["maxTokens"]) ?? DEFAULT_CAPABILITIES.maxOutputTokens,
      };
      const model: ModelDefinition = {
        id: `mod_pi_${name}_${remoteName}` as ModelId,
        providerId,
        remoteName,
        displayName: asString(m["name"]) ?? remoteName,
        capabilities,
        enabled: true,
      };
      const cost = asRecord(m["cost"]);
      if (cost !== undefined) {
        const cin = asNumber(cost["input"]);
        const cout = asNumber(cost["output"]);
        if (cin !== undefined) model.costPerMInputTokens = cin;
        if (cout !== undefined) model.costPerMOutputTokens = cout;
      }
      models.push(model);
    }

    if (options.dryRun !== true) {
      options.db.providers.put(provider);
      for (const model of models) options.db.models.put(model);
      tracker.mark(sourceKey, providerId);
    }
    report.imported(1 + models.length);
  }
}

async function importAuthJson(
  path: string,
  options: PiSettingsImportOptions,
  report: PiSettingsReportBuilder,
  tracker: ImportStateTracker,
): Promise<void> {
  if (!existsSync(path)) return;
  const result = readJsonFile(path);
  if (!result.ok) {
    report.error(path, result.error);
    return;
  }
  const root = asRecord(result.value);
  if (root === undefined) {
    report.error(path, "auth.json is not a JSON object");
    return;
  }
  for (const [provider, rawCred] of Object.entries(root)) {
    const sourceKey = `auth:${provider}`;
    if (tracker.has(sourceKey)) {
      report.skip(sourceKey, "already imported");
      continue;
    }
    const cred = asRecord(rawCred);
    const type = cred === undefined ? undefined : asString(cred["type"]);
    if (cred === undefined || type === undefined) {
      report.error(sourceKey, "credential entry missing a type");
      continue;
    }
    if (options.secretStore === undefined) {
      report.skip(sourceKey, "no SecretStore configured; secrets not imported");
      report.warn(`${sourceKey}: credentials skipped — inject a SecretStore to import them`);
      continue;
    }
    const store = options.secretStore;
    let stored = 0;
    if (type === "api_key") {
      const key = asString(cred["key"]);
      if (key !== undefined) {
        if (options.dryRun !== true) await store.set(`pi:auth:${provider}:apiKey`, key);
        stored += 1;
      }
      const env = asRecord(cred["env"]);
      if (env !== undefined) {
        for (const [envKey, envValue] of Object.entries(env)) {
          if (typeof envValue !== "string") continue;
          if (options.dryRun !== true) {
            await store.set(`pi:auth:${provider}:env:${envKey}`, envValue);
          }
          stored += 1;
        }
      }
    } else if (type === "oauth") {
      if (options.dryRun !== true) {
        await store.set(`pi:auth:${provider}:oauth`, JSON.stringify(cred));
      }
      stored += 1;
    } else {
      report.warn(`${sourceKey}: unknown credential type "${type}"; skipped`);
      report.skip(sourceKey, `unknown credential type "${type}"`);
      continue;
    }
    if (options.dryRun !== true) tracker.mark(sourceKey, `pi:auth:${provider}`);
    report.secretsStored += stored;
    report.imported();
  }
}

/**
 * Import Pi settings/resources/models/auth. Async because the SecretStore
 * interface is async; file and database work is synchronous.
 */
export async function importPiSettings(
  options: PiSettingsImportOptions,
): Promise<PiSettingsImportReport> {
  const report = new PiSettingsReportBuilder();
  const dryRun = options.dryRun ?? false;
  const tracker = new ImportStateTracker(options.db, "pi.settings", dryRun);
  const schemaKeys =
    options.schemaKeys === undefined ? undefined : new Set<string>(options.schemaKeys);

  // 1. settings.json (global first, project overrides).
  const settingsFiles: Array<{ path: string; label: string }> = [
    { path: join(options.agentDir, "settings.json"), label: "global" },
  ];
  if (options.projectDir !== undefined) {
    settingsFiles.push({ path: join(options.projectDir, ".pi", "settings.json"), label: "project" });
  }
  for (const { path, label } of settingsFiles) {
    const sourceKey = `settings:${label}:${path}`;
    if (!existsSync(path)) continue;
    if (tracker.has(sourceKey)) {
      report.skip(sourceKey, "already imported");
      continue;
    }
    const result = readJsonFile(path);
    if (!result.ok) {
      report.error(path, result.error);
      continue;
    }
    const settings = asRecord(result.value);
    if (settings === undefined) {
      report.error(path, "settings.json is not a JSON object");
      continue;
    }
    importSettingsObject(settings, path, options, report, schemaKeys);
    if (!dryRun) tracker.mark(sourceKey, `${options.settingsScope ?? "global"}/${options.settingsScopeId ?? "global"}`);
  }

  // 2. Resource directories.
  const resourceRoots: Array<{ root: string; label: string }> = [
    { root: options.agentDir, label: "global" },
  ];
  if (options.projectDir !== undefined) {
    resourceRoots.push({ root: join(options.projectDir, ".pi"), label: "project" });
  }
  for (const { root, label } of resourceRoots) {
    for (const { name, recursive } of RESOURCE_DIRS) {
      copyResourceDir(
        join(root, name),
        join(options.dataDir, "pi", label, name),
        recursive,
        label,
        options,
        report,
        tracker,
      );
    }
  }

  // 3. models.json → providers/models (+ literal apiKeys into SecretStore).
  await importModelsJson(join(options.agentDir, "models.json"), options, report, tracker);

  // 4. auth.json → SecretStore only.
  await importAuthJson(join(options.agentDir, "auth.json"), options, report, tracker);

  return report.finishPi();
}

/** Stateful facade around {@link importPiSettings}. */
export class PiSettingsImporter {
  constructor(private readonly db: OmniDatabase) {}

  import(
    options: Omit<PiSettingsImportOptions, "db">,
  ): Promise<PiSettingsImportReport> {
    return importPiSettings({ ...options, db: this.db });
  }
}

export type { ImportError, ImportReport, ImportSkip };
