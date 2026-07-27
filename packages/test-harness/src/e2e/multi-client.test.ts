import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OmniClient } from "@omniharness/client-sdk";
import { startDaemon, stopDaemon, type DaemonContext } from "@omniharness/daemon";

/**
 * E2E acceptance scenarios (spec §23, subset):
 *  - #2/#3: two different clients share the same session state in real time
 *  - #15: daemon restart preserves sessions and event history; clients resync
 */

interface RunningDaemon {
  ctx: DaemonContext;
  dataDir: string;
  port: number;
  token: string;
}

async function boot(dataDir?: string): Promise<RunningDaemon> {
  const dir = dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "omni-e2e-"));
  process.env.OMNIHARNESS_DATA_DIR = dir;
  const ctx = await startDaemon({ dataDir: dir, port: 0 });
  const info = JSON.parse(fs.readFileSync(path.join(dir, "daemon.json"), "utf8")) as {
    port: number;
    authToken: string;
  };
  return { ctx, dataDir: dir, port: info.port, token: info.authToken };
}

async function connect(d: RunningDaemon, name: string, lastEventSeq?: number): Promise<OmniClient> {
  const client = new OmniClient({
    url: `ws://127.0.0.1:${d.port}`,
    authToken: d.token,
    client: { kind: "sdk", name, version: "0" },
    ...(lastEventSeq !== undefined ? { lastEventSeq } : {}),
    autoReconnect: false,
  });
  await client.connect();
  return client;
}

describe("multi-client + restart e2e", () => {
  let daemon: RunningDaemon;

  beforeAll(async () => {
    daemon = await boot();
  }, 30_000);

  afterAll(async () => {
    if (daemon) {
      await stopDaemon(daemon.ctx).catch(() => undefined);
      fs.rmSync(daemon.dataDir, { recursive: true, force: true });
    }
  });

  it("scenario #2/#3: a session created by one client is live for another", async () => {
    const gui = await connect(daemon, "gui");
    const tui = await connect(daemon, "tui");

    const { project } = await gui.call("project.create", { name: "shared" });
    const { workspace } = await gui.call("workspace.register", {
      projectId: project.id,
      roots: ["/tmp/shared"],
    });
    const { session } = await gui.call("session.create", {
      workspaceId: workspace.id,
      title: "shared session",
    });

    // The TUI sees it in its listing.
    const list = await tui.call("session.list", {});
    expect(list.sessions.some((s) => s.id === session.id)).toBe(true);

    // Rename from TUI → GUI receives the event in real time.
    const seen = new Promise<string>((resolve) => {
      const off = gui.onEvent((e) => {
        if (e.type === "session.updated" && e.sessionId === session.id) {
          off();
          resolve(e.title);
        }
      });
    });
    await tui.call("session.rename", { sessionId: session.id, title: "renamed from tui" });
    await expect(seen).resolves.toBe("renamed from tui");

    await gui.close();
    await tui.close();
  });

  it("scenario #15: restart preserves sessions and replays missed events", async () => {
    const client = await connect(daemon, "before-restart");
    const { project } = await client.call("project.create", { name: "durable" });
    const { workspace } = await client.call("workspace.register", {
      projectId: project.id,
      roots: ["/tmp/durable"],
    });
    const { session } = await client.call("session.create", {
      workspaceId: workspace.id,
      title: "survives restart",
    });
    const seqBefore = client.latestSeq;
    await client.close();

    // Stop and restart against the SAME data dir.
    await stopDaemon(daemon.ctx);
    daemon = await boot(daemon.dataDir);
    const client2 = await connect(daemon, "after-restart", seqBefore);

    const { session: restored } = await client2.call("session.get", { sessionId: session.id });
    expect(restored.title).toBe("survives restart");

    // Missed events (the daemon.shutdown + everything since) replay.
    const { events, latestSeq } = await client2.call("events.since", { seq: seqBefore });
    expect(latestSeq).toBeGreaterThan(seqBefore);
    expect(events.length).toBeGreaterThan(0);

    await client2.close();
  });
});
