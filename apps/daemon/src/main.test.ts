import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OmniClient } from "@omniharness/client-sdk";
import { startDaemon, stopDaemon } from "./main.js";
import type { DaemonContext } from "./context.js";

/**
 * End-to-end: boot a real daemon (random port, temp data dir), drive it with
 * the real client SDK, verify events + reconnect replay.
 */
describe("daemon e2e", () => {
  let ctx: DaemonContext;
  let client: OmniClient;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-daemon-test-"));
    process.env.OMNIHARNESS_DATA_DIR = dataDir;
    ctx = await startDaemon({ dataDir, port: 0 });
    const info = JSON.parse(fs.readFileSync(path.join(dataDir, "daemon.json"), "utf8")) as {
      port: number;
      authToken: string;
    };
    client = new OmniClient({
      url: `ws://127.0.0.1:${info.port}`,
      authToken: info.authToken,
      client: { kind: "sdk", name: "test", version: "0" },
      autoReconnect: false,
    });
    await client.connect();
  }, 30_000);

  afterAll(async () => {
    await client.close();
    await stopDaemon(ctx);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("pings", async () => {
    const pong = await client.call("system.ping", {});
    expect(pong.ok).toBe(true);
    expect(pong.version).toBe("0.1.0");
  });

  it("runs diagnostics", async () => {
    const report = await client.call("system.diagnostics", {});
    expect(report.checks.length).toBeGreaterThan(0);
    expect(report.checks.find((c) => c.name === "database integrity")?.ok).toBe(true);
  });

  it("creates project/workspace/session and streams events", async () => {
    const events: string[] = [];
    const unsub = client.onEvent((e) => events.push(e.type));

    const { project } = await client.call("project.create", { name: "demo" });
    const { workspace } = await client.call("workspace.register", {
      projectId: project.id,
      roots: ["/tmp/demo"],
    });
    const { session } = await client.call("session.create", {
      workspaceId: workspace.id,
      title: "e2e session",
    });
    expect(session.title).toBe("e2e session");

    const { session: fetched } = await client.call("session.get", { sessionId: session.id });
    expect(fetched.id).toBe(session.id);

    const list = await client.call("session.list", {});
    expect(list.total).toBeGreaterThanOrEqual(1);

    await client.call("session.rename", { sessionId: session.id, title: "renamed" });
    unsub();
    expect(events).toContain("session.created");
    expect(events).toContain("session.updated");
  });

  it("memory round trip with approval", async () => {
    const { memory } = await client.call("memory.add", {
      content: "The user prefers pnpm over npm",
      kind: "userPreference",
    });
    expect(memory.approvedByUser).toBe(true);
    const { results } = await client.call("memory.search", { text: "pnpm" });
    expect(results.length).toBeGreaterThan(0);
    await client.call("memory.delete", { memoryId: memory.id });
    const after = await client.call("memory.search", { text: "pnpm" });
    expect(after.results.find((r) => r.entry.id === memory.id)).toBeUndefined();
  });

  it("rejects bad auth token", async () => {
    const info = JSON.parse(fs.readFileSync(path.join(dataDir, "daemon.json"), "utf8")) as {
      port: number;
    };
    const bad = new OmniClient({
      url: `ws://127.0.0.1:${info.port}`,
      authToken: "wrong-token",
      client: { kind: "sdk", name: "test", version: "0" },
      autoReconnect: false,
    });
    await expect(bad.connect()).rejects.toThrow();
  });

  it("replays events on reconnect with lastEventSeq", async () => {
    const info = JSON.parse(fs.readFileSync(path.join(dataDir, "daemon.json"), "utf8")) as {
      port: number;
      authToken: string;
    };
    const { project } = await client.call("project.create", { name: "replay-test" });
    void project;
    const latestSeq = client.latestSeq;
    // Create one more event, then reconnect from before it.
    await client.call("project.create", { name: "replay-test-2" });
    const reconnected = new OmniClient({
      url: `ws://127.0.0.1:${info.port}`,
      authToken: info.authToken,
      client: { kind: "sdk", name: "test2", version: "0" },
      lastEventSeq: Math.max(0, latestSeq - 1),
      autoReconnect: false,
    });
    const replayed: number[] = [];
    reconnected.onEvent((e) => replayed.push(e.seq));
    await reconnected.connect();
    expect(replayed.length).toBeGreaterThan(0);
    await reconnected.close();
  });
});
