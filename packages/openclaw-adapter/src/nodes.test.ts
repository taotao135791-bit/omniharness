import { describe, expect, it } from "vitest";
import { collectingAudit } from "./audit.js";
import type { EventFrame } from "./frames.js";
import {
  DEFAULT_DANGEROUS_NODE_COMMANDS,
  NodeBridge,
  NodeInvokeError,
  NodeRegistry,
  commandCapability,
  isDangerousNodeCommand,
} from "./nodes.js";
import type { NodeTransport } from "./nodes.js";

class RecordingTransport implements NodeTransport {
  readonly frames: EventFrame[] = [];
  sendEvent(frame: EventFrame): void {
    this.frames.push(frame);
  }
}

const phone = {
  nodeId: "node-1",
  name: "Pixel",
  platform: "android",
  capabilities: ["camera", "screen", "location"],
  pairedAt: new Date().toISOString(),
};

describe("NodeRegistry", () => {
  it("pairs, lists, revokes — all audited", () => {
    const { sink, events } = collectingAudit();
    const registry = new NodeRegistry(sink);
    registry.pair(phone);
    expect(registry.isPaired("node-1")).toBe(true);
    expect(registry.list()).toHaveLength(1);
    expect(registry.get("node-1")?.capabilities).toContain("camera");
    expect(events.some((e) => e.kind === "node.paired" && e.nodeId === "node-1")).toBe(true);

    expect(registry.revoke("node-1")).toBe(true);
    expect(registry.isPaired("node-1")).toBe(false);
    expect(events.some((e) => e.kind === "node.revoked" && e.nodeId === "node-1")).toBe(true);
  });
});

describe("dangerous command policy", () => {
  it("classifies per upstream DEFAULT_DANGEROUS_NODE_COMMANDS", () => {
    expect(isDangerousNodeCommand("camera.snap")).toBe(true);
    expect(isDangerousNodeCommand("screen.record")).toBe(true);
    expect(isDangerousNodeCommand("sms.send")).toBe(true);
    expect(isDangerousNodeCommand("location.get")).toBe(false);
    expect(DEFAULT_DANGEROUS_NODE_COMMANDS).toContain("computer.act");
  });

  it("derives capability prefixes", () => {
    expect(commandCapability("camera.snap")).toBe("camera");
    expect(commandCapability("location.get")).toBe("location");
  });
});

describe("NodeBridge.invoke", () => {
  it("sends node.invoke.request and resolves on node.invoke.result", async () => {
    const registry = new NodeRegistry();
    registry.pair(phone);
    const transport = new RecordingTransport();
    const bridge = new NodeBridge(registry, transport);

    const promise = bridge.invoke(
      "node-1",
      "location.get",
      { accuracy: "high" },
      { timeoutMs: 500 },
    );
    expect(transport.frames).toHaveLength(1);
    const frame = transport.frames[0];
    expect(frame?.event).toBe("node.invoke.request");
    const payload = frame?.payload as Record<string, unknown>;
    expect(payload).toMatchObject({ nodeId: "node-1", command: "location.get", timeoutMs: 500 });
    expect(JSON.parse(String(payload["paramsJSON"]))).toEqual({ accuracy: "high" });

    bridge.handleGatewayFrame({
      type: "req",
      id: "resp-1",
      method: "node.invoke.result",
      params: { id: payload["id"], nodeId: "node-1", ok: true, payloadJSON: '{"lat":1,"lng":2}' },
    });
    await expect(promise).resolves.toEqual({ ok: true, payload: { lat: 1, lng: 2 } });
    expect(bridge.pendingCount).toBe(0);
  });

  it("resolves ok:false with the node error message", async () => {
    const registry = new NodeRegistry();
    registry.pair(phone);
    const transport = new RecordingTransport();
    const bridge = new NodeBridge(registry, transport);
    const promise = bridge.invoke("node-1", "location.get", undefined, { timeoutMs: 500 });
    const payload = transport.frames[0]?.payload as Record<string, unknown>;
    bridge.handleGatewayFrame({
      type: "req",
      id: "r",
      method: "node.invoke.result",
      params: {
        id: payload["id"],
        nodeId: "node-1",
        ok: false,
        error: { code: "UNAVAILABLE", message: "gps off" },
      },
    });
    await expect(promise).resolves.toEqual({ ok: false, error: "gps off" });
  });

  it("rejects unpaired nodes", async () => {
    const bridge = new NodeBridge(new NodeRegistry(), new RecordingTransport());
    await expect(bridge.invoke("ghost", "location.get")).rejects.toMatchObject({
      code: "not_paired",
    } satisfies Partial<NodeInvokeError>);
  });

  it("rejects commands whose capability the node does not declare", async () => {
    const registry = new NodeRegistry();
    registry.pair(phone); // no "sms" capability
    const bridge = new NodeBridge(registry, new RecordingTransport(), {
      armedCommands: ["sms.send"],
    });
    await expect(bridge.invoke("node-1", "sms.send")).rejects.toMatchObject({
      code: "capability_missing",
    });
  });

  it("refuses dangerous commands unless armed, and audits both", async () => {
    const { sink, events } = collectingAudit();
    const registry = new NodeRegistry();
    registry.pair(phone);
    const transport = new RecordingTransport();
    const bridge = new NodeBridge(registry, transport, { audit: sink });

    await expect(bridge.invoke("node-1", "camera.snap")).rejects.toMatchObject({
      code: "not_armed",
    });
    expect(transport.frames).toHaveLength(0);
    expect(
      events.some((e) => e.kind === "node.invoke" && !e.allowed && e.reason === "not_armed"),
    ).toBe(true);

    const armed = new NodeBridge(registry, transport, {
      armedCommands: ["camera.snap"],
      audit: sink,
    });
    const promise = armed.invoke("node-1", "camera.snap", undefined, { timeoutMs: 500 });
    expect(transport.frames).toHaveLength(1);
    const payload = transport.frames[0]?.payload as Record<string, unknown>;
    armed.handleGatewayFrame({
      type: "req",
      id: "r",
      method: "node.invoke.result",
      params: { id: payload["id"], nodeId: "node-1", ok: true, payload: { path: "/tmp/snap.jpg" } },
    });
    await expect(promise).resolves.toEqual({ ok: true, payload: { path: "/tmp/snap.jpg" } });
    expect(events.some((e) => e.kind === "node.invoke" && e.allowed)).toBe(true);
  });

  it("times out when no result arrives", async () => {
    const registry = new NodeRegistry();
    registry.pair(phone);
    const bridge = new NodeBridge(registry, new RecordingTransport());
    await expect(
      bridge.invoke("node-1", "location.get", undefined, { timeoutMs: 20 }),
    ).rejects.toMatchObject({
      code: "timeout",
    });
    expect(bridge.pendingCount).toBe(0);
  });
});
