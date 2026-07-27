#!/usr/bin/env node
import { loadBrand } from "@omniharness/config-schema";
import type { SessionId } from "@omniharness/shared-types";
import { parseArgs, optBool, optString } from "./args.js";
import { connectToDaemon } from "./connect.js";
import { printJson, printTable } from "./output.js";

const HELP = `omni — OmniHarness CLI

Usage: omni <resource> <action> [options] [--json]

Resources:
  doctor                        Run system diagnostics
  daemon status                 Show daemon info
  session list|create|show|rename|archive|export|import
  run start|steer|interrupt|resume|retry   (agent runs; streams events)
  provider list|add|test|remove
  model list|bind|bindings
  tool list
  approval list|approve|deny
  diff show|accept|reject
  checkpoint create|list|restore
  task list|create|pause|resume|cancel
  memory list|search|add|approve|reject|delete
  skill list|enable|disable|install|proposals|approve|reject
  automation list|create|enable|disable|run|runs|delete
  plugin list|install|enable|disable|uninstall
  settings get|set
  channel list|pair     node list
  data export|delete
  version

Common options:
  --json                machine-readable output
  --workspace <id>      workspace for session create
  --session <id>        target session
  --help                this help
`;

async function main(): Promise<number> {
  const { positional, options } = parseArgs(process.argv.slice(2));
  const [resource, action, ...rest] = positional;
  const json = optBool(options, "json");
  const brand = loadBrand();

  if (!resource || optBool(options, "help") || resource === "help") {
    console.log(HELP);
    return 0;
  }
  if (resource === "version" || resource === "--version") {
    console.log(`${brand.product.displayName} CLI 0.1.0 (${brand.product.codeName})`);
    return 0;
  }

  const client = await connectToDaemon();
  try {
    switch (resource) {
      case "doctor": {
        const report = await client.call("system.diagnostics", {});
        if (json) printJson(report);
        else {
          for (const c of report.checks)
            console.log(`${c.ok ? "✅" : "❌"} ${c.name} — ${c.detail}`);
          console.log(
            `data dir: ${report.dataDir}, db: ${(report.dbSizeBytes / 1024).toFixed(0)} KiB`,
          );
        }
        return report.ok ? 0 : 1;
      }
      case "daemon": {
        const pong = await client.call("system.ping", {});
        if (json) printJson(pong);
        else console.log(`daemon v${pong.version}, up ${(pong.uptimeMs / 1000).toFixed(0)}s`);
        return 0;
      }
      case "session": {
        if (action === "list") {
          const r = await client.call("session.list", {
            limit: 50,
            ...(optString(options, "workspace")
              ? { workspaceId: optString(options, "workspace")! }
              : {}),
          });
          if (json) printJson(r);
          else
            printTable(
              r.sessions.map((s) => ({
                id: s.id,
                title: s.title,
                status: s.status,
                updated: s.updatedAt,
              })),
            );
          return 0;
        }
        if (action === "create") {
          const workspaceId = optString(options, "workspace");
          if (!workspaceId) throw new Error("--workspace <id> required");
          const r = await client.call("session.create", {
            workspaceId,
            ...(optString(options, "title") ? { title: optString(options, "title")! } : {}),
          });
          if (json) printJson(r.session);
          else console.log(r.session.id);
          return 0;
        }
        if (action === "archive") {
          const id = optString(options, "session") ?? rest[0];
          if (!id) throw new Error("session id required");
          await client.call("session.archive", { sessionId: id as SessionId });
          return 0;
        }
        if (action === "rename") {
          const id = optString(options, "session") ?? rest[0];
          const title = optString(options, "title") ?? rest[1];
          if (!id || !title) throw new Error("usage: omni session rename <id> <title>");
          await client.call("session.rename", { sessionId: id as SessionId, title });
          return 0;
        }
        throw new Error(`unknown session action: ${action ?? "(none)"}`);
      }
      case "run": {
        if (action === "start") {
          const sessionId = optString(options, "session");
          const input = rest.join(" ") || optString(options, "input");
          if (!sessionId || !input)
            throw new Error("usage: omni run start --session <id> <prompt>");
          const unsub = client.onEvent((e) => {
            if (e.type === "message.delta" && e.sessionId === sessionId && e.channel === "text") {
              process.stdout.write(e.delta);
            }
            if (e.type === "run.completed" && e.sessionId === sessionId) {
              process.stdout.write(
                `\n[done: ${e.usage.inputTokens}in/${e.usage.outputTokens}out]\n`,
              );
            }
            if (e.type === "run.failed") console.error(`\n[failed: ${e.error}]`);
          });
          await client.call("run.start", { sessionId: sessionId as SessionId, input });
          // Wait until the run finishes.
          await new Promise<void>((resolve) => {
            const off = client.onEvent((e) => {
              if (
                (e.type === "run.completed" || e.type === "run.failed") &&
                e.sessionId === sessionId
              ) {
                off();
                resolve();
              }
            });
          });
          unsub();
          return 0;
        }
        if (action === "interrupt") {
          const runId = optString(options, "run") ?? rest[0];
          if (!runId) throw new Error("run id required");
          await client.call("run.interrupt", { runId });
          return 0;
        }
        throw new Error(`unknown run action: ${action ?? "(none)"}`);
      }
      case "provider": {
        if (action === "list") {
          const r = await client.call("provider.list", {});
          if (json) printJson(r);
          else
            printTable(
              r.providers.map((p) => ({
                id: p.id,
                kind: p.kind,
                name: p.displayName,
                enabled: p.enabled,
              })),
            );
          return 0;
        }
        if (action === "add") {
          const kind = optString(options, "kind");
          const name = optString(options, "name");
          if (!kind || !name)
            throw new Error(
              "usage: omni provider add --kind <kind> --name <name> [--base-url <url>] [--api-key <key>]",
            );
          const r = await client.call("provider.add", {
            kind: kind as never,
            displayName: name,
            ...(optString(options, "base-url") ? { baseUrl: optString(options, "base-url")! } : {}),
            ...(optString(options, "api-key") ? { apiKey: optString(options, "api-key")! } : {}),
          });
          if (json) printJson(r.provider);
          else console.log(`added provider ${r.provider.id}`);
          return 0;
        }
        if (action === "test") {
          const id = optString(options, "provider") ?? rest[0];
          if (!id) throw new Error("provider id required");
          const r = await client.call("provider.test", { providerId: id });
          if (json) printJson(r);
          else console.log(r.ok ? `ok (${r.latencyMs}ms)` : `failed: ${r.error ?? "unknown"}`);
          return r.ok ? 0 : 1;
        }
        throw new Error(`unknown provider action: ${action ?? "(none)"}`);
      }
      case "model": {
        if (action === "list") {
          const r = await client.call("model.list", {});
          if (json) printJson(r);
          else
            printTable(
              r.models.map((m) => ({
                id: m.id,
                provider: m.providerId,
                name: m.displayName,
                vision: m.capabilities.vision,
                tools: m.capabilities.nativeToolCalling,
                ctx: m.capabilities.contextWindow,
              })),
            );
          return 0;
        }
        throw new Error(`unknown model action: ${action ?? "(none)"}`);
      }
      case "approval": {
        if (action === "list") {
          const r = await client.call("approval.list", { limit: 50 });
          if (json) printJson(r);
          else
            printTable(
              r.approvals.map((a) => ({
                id: a.id,
                capability: a.capability,
                risk: a.risk,
                summary: a.summary.slice(0, 60),
                status: a.status,
              })),
            );
          return 0;
        }
        if (action === "approve" || action === "deny") {
          const id = rest[0];
          if (!id) throw new Error("approval id required");
          await client.call("approval.resolve", {
            approvalId: id,
            decision: action === "approve" ? "approve" : "deny",
          });
          return 0;
        }
        throw new Error(`unknown approval action: ${action ?? "(none)"}`);
      }
      case "tool": {
        const r = await client.call("tool.list", {});
        if (json) printJson(r);
        else
          printTable(
            r.tools.map((t) => ({
              name: t.name,
              source: t.source,
              capabilities: t.capabilities.join(","),
            })),
          );
        return 0;
      }
      case "memory": {
        if (action === "search") {
          const text = rest.join(" ") || optString(options, "q");
          if (!text) throw new Error("usage: omni memory search <query>");
          const r = await client.call("memory.search", { text });
          if (json) printJson(r);
          else
            printTable(
              r.results.map((m) => ({
                id: m.entry.id,
                kind: m.entry.kind,
                score: m.score.toFixed(2),
                summary: m.entry.summary.slice(0, 60),
              })),
            );
          return 0;
        }
        throw new Error(`unknown memory action: ${action ?? "(none)"}`);
      }
      case "skill": {
        if (action === "list") {
          const r = await client.call("skill.list", {});
          if (json) printJson(r);
          else
            printTable(
              r.skills.map((s) => ({
                name: s.name,
                version: s.version,
                scope: s.scope,
                enabled: s.enabled,
                source: s.source,
              })),
            );
          return 0;
        }
        throw new Error(`unknown skill action: ${action ?? "(none)"}`);
      }
      case "automation": {
        if (action === "list") {
          const r = await client.call("automation.list", {});
          if (json) printJson(r);
          else
            printTable(
              r.automations.map((a) => ({
                id: a.id,
                name: a.name,
                enabled: a.enabled,
                next: a.nextRunAt ?? "-",
              })),
            );
          return 0;
        }
        if (action === "run") {
          const id = rest[0];
          if (!id) throw new Error("automation id required");
          const r = await client.call("automation.runNow", { automationId: id });
          console.log(`run ${r.runId} started`);
          return 0;
        }
        throw new Error(`unknown automation action: ${action ?? "(none)"}`);
      }
      case "diff": {
        const r = await client.call(
          "diff.get",
          optString(options, "session")
            ? { sessionId: optString(options, "session")! as SessionId }
            : {},
        );
        if (json) printJson(r);
        else
          printTable(
            r.files.map((f) => ({
              path: f.path,
              status: f.status,
              "+": f.additions,
              "-": f.deletions,
              hunks: f.hunks.length,
            })),
          );
        return 0;
      }
      case "settings": {
        if (action === "get") {
          const r = await client.call("settings.get", {});
          printJson(r.settings);
          return 0;
        }
        if (action === "set") {
          const key = rest[0];
          const value = rest[1];
          if (!key || value === undefined)
            throw new Error("usage: omni settings set <key> <value>");
          let parsed: unknown = value;
          try {
            parsed = JSON.parse(value);
          } catch {
            /* keep as string */
          }
          await client.call("settings.set", { key, value: parsed });
          return 0;
        }
        throw new Error(`unknown settings action: ${action ?? "(none)"}`);
      }
      default:
        console.error(`unknown resource: ${resource}\n`);
        console.log(HELP);
        return 2;
    }
  } finally {
    await client.close();
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
