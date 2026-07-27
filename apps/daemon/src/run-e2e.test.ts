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
 * Acceptance scenario #1 with a deterministic fake model — a full agent run
 * through the real stack: RPC client → daemon → runtime-pi (real Pi agent
 * loop) → ToolRuntime policy pipeline → workspace on disk.
 */
describe("agent run e2e (fixture provider)", () => {
  let ctx: DaemonContext;
  let client: OmniClient;
  let dataDir: string;
  let wsRoot: string;
  let workspaceId: string;

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-run-e2e-"));
    wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omni-run-ws-"));
    process.env.OMNIHARNESS_DATA_DIR = dataDir;
    process.env.OMNIHARNESS_AUTOMATIONS = "off";

    const script: FixtureResponse[] = [
      // Turn 1: model calls fs.write inside the workspace (policy: allow_for_workspace).
      fixture.toolCall(
        "fs.write",
        JSON.stringify({ path: path.join(wsRoot, "hello.txt"), content: "hello from agent" }),
        "call_write",
      ),
      fixture.text("I wrote hello.txt.", { usage: { inputTokens: 10, outputTokens: 5 } }),
      // Turn 2 (second session): model calls shell.exec (policy: ask_every_time).
      fixture.toolCall(
        "shell.exec",
        JSON.stringify({ command: "echo approval-works" }),
        "call_shell",
      ),
      fixture.text("Shell command done.", { usage: { inputTokens: 12, outputTokens: 6 } }),
    ];

    ctx = await startDaemon({
      dataDir,
      port: 0,
      fixtureScripts: new Map([["prov_fixture", script]]),
    });
    ctx.db.providers.put({
      id: "prov_fixture" as ProviderConfig["id"],
      kind: "fixture",
      displayName: "Fixture",
      enabled: true,
      rateLimitRpm: 0,
      timeoutMs: 10_000,
      maxRetries: 0,
    });
    ctx.db.models.put({
      id: "model_fixture" as ModelDefinition["id"],
      providerId: "prov_fixture" as ProviderConfig["id"],
      remoteName: "fixture-model",
      displayName: "Fixture Model",
      capabilities: { ...DEFAULT_CAPABILITIES, nativeToolCalling: true, contextWindow: 100_000 },
      enabled: true,
    });
    ctx.db.settings.set("profile", "", "models.bindings.primary", "model_fixture");

    const info = JSON.parse(fs.readFileSync(path.join(dataDir, "daemon.json"), "utf8")) as {
      port: number;
      authToken: string;
    };
    client = new OmniClient({
      url: `ws://127.0.0.1:${info.port}`,
      authToken: info.authToken,
      client: { kind: "sdk", name: "e2e", version: "0" },
      autoReconnect: false,
    });
    await client.connect();

    const { project } = await client.call("project.create", { name: "e2e" });
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

  function waitForRunEnd(sessionId: string): Promise<{ ok: boolean }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("run timed out")), 25_000);
      const off = client.onEvent((e) => {
        if (e.type === "run.completed" && e.sessionId === sessionId) {
          clearTimeout(timer);
          off();
          resolve({ ok: true });
        }
        if (e.type === "run.failed" && e.sessionId === sessionId) {
          clearTimeout(timer);
          off();
          reject(new Error(e.error));
        }
      });
    });
  }

  it("scenario #1: agent writes a file through the real pipeline", async () => {
    const { session } = await client.call("session.create", { workspaceId, title: "write-file" });
    const done = waitForRunEnd(session.id);
    await client.call("run.start", { sessionId: session.id, input: "write hello.txt" });
    await done;

    expect(fs.readFileSync(path.join(wsRoot, "hello.txt"), "utf8")).toBe("hello from agent");

    const { messages } = await client.call("session.messages", { sessionId: session.id });
    const assistant = messages.filter((m) => m.role === "assistant");
    expect(assistant.length).toBeGreaterThan(0);

    const { runs } = await client.call("run.list", { sessionId: session.id });
    expect(runs[0]?.status).toBe("completed");
  }, 30_000);

  it("shell.exec requires approval; approving lets the run finish", async () => {
    const { session } = await client.call("session.create", {
      workspaceId,
      title: "shell-approval",
    });
    const done = waitForRunEnd(session.id);

    const approvalSeen = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no approval requested")), 20_000);
      const off = client.onEvent((e) => {
        if (e.type === "approval.requested") {
          clearTimeout(timer);
          off();
          resolve(e.approval.id);
        }
      });
    });

    await client.call("run.start", { sessionId: session.id, input: "run echo" });
    const approvalId = await approvalSeen;
    await client.call("approval.resolve", { approvalId, decision: "approve" });
    await done;

    const { runs } = await client.call("run.list", { sessionId: session.id });
    expect(runs[0]?.status).toBe("completed");
  }, 30_000);
});
