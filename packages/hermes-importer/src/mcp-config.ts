import type { OmniDatabase } from "@omniharness/session-store";
import { ImportStateTracker } from "./import-state.js";
import { asRecord, asString, asStringArray, readJsonFile } from "./json-utils.js";
import { type ImportOptions, type ImportReport, ImportReportBuilder } from "./report.js";
import type { SecretStore } from "./secret-store.js";

/**
 * Importer for MCP server configs in the Claude/Codex convention:
 *
 *   { "mcpServers": { "<name>": { "command": "...", "args": [...], "env": {...} } } }
 *
 * Produces registration RECORDS AS DATA — nothing is executed, no processes
 * are spawned. Registrations are persisted in the settings table
 * (scope global / scopeId "mcp") so the daemon can pick them up. Env values
 * whose names look secret (KEY/TOKEN/SECRET/PASSWORD) go to the injected
 * SecretStore and are replaced by refs; everything else stays inline.
 */

export interface McpServerRegistration {
  name: string;
  command: string;
  args: string[];
  /** Non-secret env values (secret-looking ones are replaced by refs). */
  env: Record<string, string>;
  /** Refs into the SecretStore for secret env values. */
  secretEnvRefs: Record<string, string>;
  sourcePath: string;
}

export interface McpImportReport extends ImportReport {
  servers: McpServerRegistration[];
}

export interface McpConfigImportOptions extends ImportOptions {
  db: OmniDatabase;
  secretStore?: SecretStore;
}

const SECRETISH_ENV = /(key|token|secret|password)/i;

/** Parse an mcpServers JSON document (already-parsed value) into registrations. */
export function parseMcpServers(
  value: unknown,
  sourcePath: string,
  report: ImportReportBuilder,
): McpServerRegistration[] {
  const root = asRecord(value);
  const servers = root === undefined ? undefined : asRecord(root["mcpServers"]);
  if (servers === undefined) {
    report.error(sourcePath, "config does not match the expected shape ({mcpServers: {...}})");
    return [];
  }
  const out: McpServerRegistration[] = [];
  for (const [name, rawServer] of Object.entries(servers)) {
    const rec = asRecord(rawServer);
    if (rec === undefined) {
      report.error(name, "server entry is not an object; skipped");
      continue;
    }
    const command = asString(rec["command"]);
    if (command === undefined || command.length === 0) {
      report.error(name, 'server entry requires a non-empty "command"; skipped');
      continue;
    }
    const args = asStringArray(rec["args"]) ?? [];
    const env: Record<string, string> = {};
    const rawEnv = asRecord(rec["env"]);
    if (rawEnv !== undefined) {
      for (const [k, v] of Object.entries(rawEnv)) {
        if (typeof v === "string") env[k] = v;
        else report.warn(`${name}: env.${k} is not a string; dropped`);
      }
    }
    out.push({ name, command, args, env, secretEnvRefs: {}, sourcePath });
  }
  return out;
}

/** Import an mcpServers JSON file as inert registration records. */
export async function importMcpConfig(
  path: string,
  options: McpConfigImportOptions,
): Promise<McpImportReport> {
  const report = new ImportReportBuilder();
  const dryRun = options.dryRun ?? false;
  const tracker = new ImportStateTracker(options.db, "mcp", dryRun);

  const result = readJsonFile(path);
  if (!result.ok) {
    report.error(path, result.error);
    return { ...report.finish(), servers: [] };
  }

  const servers: McpServerRegistration[] = [];
  for (const server of parseMcpServers(result.value, path, report)) {
    if (tracker.has(server.name)) {
      report.skip(server.name, "already imported");
      continue;
    }
    // Route secret-looking env values into the SecretStore; keep refs only.
    for (const [envKey, envValue] of Object.entries(server.env)) {
      if (!SECRETISH_ENV.test(envKey)) continue;
      if (options.secretStore === undefined) {
        report.warn(
          `${server.name}: env.${envKey} looks secret but no SecretStore is configured; kept inline`,
        );
        continue;
      }
      const ref = `mcp:${server.name}:env:${envKey}`;
      if (!dryRun) await options.secretStore.set(ref, envValue);
      server.secretEnvRefs[envKey] = ref;
      delete server.env[envKey];
    }
    if (!dryRun) {
      options.db.settings.set("global", "mcp", `server.${server.name}`, {
        name: server.name,
        command: server.command,
        args: server.args,
        env: server.env,
        secretEnvRefs: server.secretEnvRefs,
        sourcePath: server.sourcePath,
      });
      tracker.mark(server.name, `global/mcp/server.${server.name}`);
    }
    servers.push(server);
    report.imported();
  }
  return { ...report.finish(), servers };
}

/** Stateful facade around {@link importMcpConfig}. */
export class McpConfigImporter {
  constructor(private readonly db: OmniDatabase) {}

  import(path: string, options: Omit<McpConfigImportOptions, "db"> = {}): Promise<McpImportReport> {
    return importMcpConfig(path, { ...options, db: this.db });
  }
}
