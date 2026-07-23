import { describe, expect, it } from "vitest";
import { OmniClient, OmniClientError } from "./client.js";
import { WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";
import { PROTOCOL_VERSION } from "@omniharness/agent-protocol";

/** Minimal fake daemon for SDK tests. */
async function startFakeDaemon(handler?: (cmd: { id: string; name: string }) => unknown) {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  const received: Array<{ id: string; name: string }> = [];
  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw)) as { type: string; id?: string; name?: string };
      if (msg.type === "hello") {
        ws.send(
          JSON.stringify({
            type: "welcome",
            protocolVersion: PROTOCOL_VERSION,
            daemonVersion: "0.0.0-test",
            latestSeq: 0,
            replayed: false,
          }),
        );
        ws.send(
          JSON.stringify({
            type: "event",
            event: { seq: 1, at: new Date().toISOString(), type: "daemon.heartbeat", uptimeMs: 1 },
          }),
        );
        return;
      }
      if (msg.type === "command" && msg.id && msg.name) {
        received.push({ id: msg.id, name: msg.name });
        const result = handler?.({ id: msg.id, name: msg.name });
        ws.send(JSON.stringify({ type: "response", id: msg.id, ok: true, result: result ?? { ok: true } }));
      }
    });
  });
  const port = (wss.address() as AddressInfo).port;
  return { wss, url: `ws://127.0.0.1:${port}`, received };
}

describe("OmniClient", () => {
  it("connects, negotiates, calls a command, receives events", async () => {
    const daemon = await startFakeDaemon(() => ({ ok: true, version: "0.0.0-test", uptimeMs: 5 }));
    const client = new OmniClient({
      url: daemon.url,
      authToken: "test",
      client: { kind: "sdk", name: "test", version: "0" },
      autoReconnect: false,
    });
    const events: string[] = [];
    client.onEvent((e) => events.push(e.type));
    await client.connect();
    expect(client.daemonVersion).toBe("0.0.0-test");

    const pong = await client.call("system.ping", {});
    expect(pong.ok).toBe(true);
    expect(events).toContain("daemon.heartbeat");
    expect(client.latestSeq).toBe(1);

    await client.close();
    daemon.wss.close();
  });

  it("rejects on protocol mismatch", async () => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => wss.once("listening", resolve));
    wss.on("connection", (ws) => {
      ws.on("message", () => {
        ws.send(
          JSON.stringify({
            type: "welcome",
            protocolVersion: { major: 99, minor: 0 },
            daemonVersion: "x",
            latestSeq: 0,
            replayed: false,
          }),
        );
      });
    });
    const port = (wss.address() as AddressInfo).port;
    const client = new OmniClient({
      url: `ws://127.0.0.1:${port}`,
      authToken: "t",
      client: { kind: "sdk", name: "t", version: "0" },
      autoReconnect: false,
    });
    await expect(client.connect()).rejects.toBeInstanceOf(OmniClientError);
    wss.close();
  });

  it("surfaces daemon error responses as OmniClientError", async () => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => wss.once("listening", resolve));
    wss.on("connection", (ws) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(String(raw)) as { type: string; id?: string };
        if (msg.type === "hello") {
          ws.send(
            JSON.stringify({
              type: "welcome",
              protocolVersion: PROTOCOL_VERSION,
              daemonVersion: "0",
              latestSeq: 0,
              replayed: false,
            }),
          );
        } else {
          ws.send(
            JSON.stringify({
              type: "response",
              id: msg.id,
              ok: false,
              error: { code: "policy_denied", message: "nope" },
            }),
          );
        }
      });
    });
    const port = (wss.address() as AddressInfo).port;
    const client = new OmniClient({
      url: `ws://127.0.0.1:${port}`,
      authToken: "t",
      client: { kind: "sdk", name: "t", version: "0" },
      autoReconnect: false,
    });
    await client.connect();
    await expect(client.call("system.ping", {})).rejects.toMatchObject({ code: "policy_denied" });
    await client.close();
    wss.close();
  });
});
