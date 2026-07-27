import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OmniClient } from "@omniharness/client-sdk";
import { startDaemon, stopDaemon, type DaemonContext } from "./index.js";
import { fixture, type FixtureResponse } from "@omniharness/model-gateway";
import {
  DEFAULT_CAPABILITIES,
  type ModelDefinition,
  type ProviderConfig,
} from "@omniharness/shared-types";

/**
 * More acceptance scenarios with fixture models:
 *  - approval DENY → tool call denied, no execution, run finishes honestly
 *  - scenario #9: provider rate-limit (429) → router falls back to the next model
 */
describe("run e2e — deny path and rate-limit fallback", () => {
  let ctx: DaemonContext;
  let client: OmniClient;
  let dataDir: string;
  let wsRoot: string;
  let workspaceId: string;

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-e2e2-"));
    wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omni-e2e2-ws-"));
    process.env.OMNIHARNESS_DATA_DIR = dataDir;
    process.env.OMNIHARNESS_AUTOMATIONS = "off";

    const scripts = new Map<string, FixtureResponse[]>([
      [
        "prov_fixture",
        [
          // Session A: shell.exec → user will DENY → model answers anyway.
          fixture.toolCall(
            "shell.exec",
            JSON.stringify({ command: "touch SHOULD_NOT_EXIST" }),
            "c1",
          ),
          fixture.text("Understood, I will not run shell commands."),
          // Session B: text via fallback model only (primary 429s — see prov_flaky).
          fixture.text("answer from fallback model"),
        ],
      ],
      // Primary provider that always 429s (4 = one per router attempt).
      [
        "prov_flaky",
        [
          fixture.httpError(429, "rate limited", 1),
          fixture.httpError(429, "rate limited", 1),
          fixture.httpError(429, "rate limited", 1),
          fixture.httpError(429, "rate limited", 1),
        ],
      ],
    ]);

    ctx = await startDaemon({ dataDir, port: 0, fixtureScripts: scripts });

    for (const id of ["prov_fixture", "prov_flaky"] as const) {
      ctx.db.providers.put({
        id: id as ProviderConfig["id"],
        kind: "fixture",
        displayName: id,
        enabled: true,
        rateLimitRpm: 0,
        timeoutMs: 10_000,
        maxRetries: 0,
      });
    }
    const mkModel = (id: string, providerId: string, name: string): ModelDefinition => ({
      id: id as ModelDefinition["id"],
      providerId: providerId as ProviderConfig["id"],
      remoteName: name,
      displayName: name,
      capabilities: { ...DEFAULT_CAPABILITIES, nativeToolCalling: true },
      enabled: true,
    });
    ctx.db.models.put(mkModel("model_primary_flaky", "prov_flaky", "flaky-model"));
    ctx.db.models.put(mkModel("model_fallback", "prov_fixture", "fallback-model"));

    const info = JSON.parse(fs.readFileSync(path.join(dataDir, "daemon.json"), "utf8")) as {
      port: number;
      authToken: string;
    };
    client = new OmniClient({
      url: `ws://127.0.0.1:${info.port}`,
      authToken: info.authToken,
      client: { kind: "sdk", name: "e2e2", version: "0" },
      autoReconnect: false,
    });
    await client.connect();

    const { project } = await client.call("project.create", { name: "e2e2" });
    const { workspace } = await client.call("workspace.register", {
      projectId: project.id,
      roots: [wsRoot],
    });
    workspaceId = workspace.id;
  }, 60_000);

  afterAll(async () => {
    await client?.close();
    await stopDaemon(ctx);
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(wsRoot, { recursive: true, force: true });
  });

  it("approval DENY blocks execution and is recorded", async () => {
    ctx.db.settings.set("profile", "", "models.bindings.primary", "model_fallback");
    const { session } = await client.call("session.create", { workspaceId, title: "deny-test" });

    const approvalSeen = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no approval")), 20_000);
      const off = client.onEvent((e) => {
        if (e.type === "approval.requested") {
          clearTimeout(timer);
          off();
          resolve(e.approval.id);
        }
      });
    });
    const ended = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("run timeout")), 25_000);
      const off = client.onEvent((e) => {
        if ((e.type === "run.completed" || e.type === "run.failed") && e.sessionId === session.id) {
          clearTimeout(timer);
          off();
          resolve();
        }
      });
    });

    await client.call("run.start", { sessionId: session.id, input: "touch a file" });
    const approvalId = await approvalSeen;
    await client.call("approval.resolve", { approvalId, decision: "deny" });
    await ended;

    // The command never executed.
    expect(fs.existsSync(path.join(wsRoot, "SHOULD_NOT_EXIST"))).toBe(false);

    const { approvals } = await client.call("approval.list", { status: "denied" });
    expect(approvals.length).toBeGreaterThan(0);
  }, 30_000);

  it("scenario #9: 429 on primary falls back to the next model", async () => {
    // Primary = always-429 model, fallback = working fixture model.
    // Fallback chain first (db), then rebind primary via RPC so the router rebuilds.
    ctx.db.settings.set("profile", "", "models.fallbacks.primary", ["model_fallback"]);
    await client.call("model.setRoleBinding", { role: "primary", modelId: "model_primary_flaky" });

    const events: string[] = [];
    const unsub = client.onEvent((e) => {
      console.log("EV:", e.type, JSON.stringify(e).slice(0, 140));
      if (e.type === "model.fallback") events.push(`${e.fromModelId}→${e.toModelId}`);
    });

    const { session } = await client.call("session.create", {
      workspaceId,
      title: "fallback-test",
    });
    const ended = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("run timeout")), 30_000);
      const off = client.onEvent((e) => {
        if (e.type === "run.completed" && e.sessionId === session.id) {
          clearTimeout(timer);
          off();
          resolve("ok");
        }
        if (e.type === "run.failed" && e.sessionId === session.id) {
          clearTimeout(timer);
          off();
          reject(new Error(e.error));
        }
      });
    });
    await client.call("run.start", { sessionId: session.id, input: "say hi" });
    await ended;
    unsub();
    // The router fell through from the always-429 model to the working one.
    expect(events).toContain("model_primary_flaky→model_fallback");
  }, 35_000);
});
