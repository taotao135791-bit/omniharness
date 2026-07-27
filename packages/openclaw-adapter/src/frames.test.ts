import { describe, expect, it } from "vitest";
import {
  GatewayFrameError,
  OPENCLAW_PROTOCOL_VERSION,
  buildConnectRequest,
  decodeGatewayFrame,
  encodeGatewayFrame,
  encodeRequest,
  parseConnectChallenge,
  parseHelloOk,
} from "./frames.js";

describe("gateway frame codec", () => {
  it("pins protocol v4", () => {
    expect(OPENCLAW_PROTOCOL_VERSION).toBe(4);
  });

  it("round-trips a req frame", () => {
    const text = encodeRequest("1", "chat.send", { text: "hi" });
    const frame = decodeGatewayFrame(text);
    expect(frame).toEqual({ type: "req", id: "1", method: "chat.send", params: { text: "hi" } });
  });

  it("round-trips a res frame with error shape", () => {
    const raw = JSON.stringify({
      type: "res",
      id: "9",
      ok: false,
      error: { code: "FORBIDDEN", message: "nope", retryable: false, retryAfterMs: 0 },
    });
    const frame = decodeGatewayFrame(raw);
    expect(frame.type).toBe("res");
    if (frame.type !== "res") return;
    expect(frame.error).toEqual({
      code: "FORBIDDEN",
      message: "nope",
      retryable: false,
      retryAfterMs: 0,
    });
    expect(JSON.parse(encodeGatewayFrame(frame))).toEqual(JSON.parse(raw));
  });

  it("round-trips an event frame with seq", () => {
    const raw = JSON.stringify({
      type: "event",
      event: "tick",
      payload: { ts: 1 },
      seq: 42,
      stateVersion: 7,
    });
    const frame = decodeGatewayFrame(raw);
    expect(frame).toMatchObject({ type: "event", event: "tick", seq: 42, stateVersion: 7 });
    expect(JSON.parse(encodeGatewayFrame(frame))).toEqual(JSON.parse(raw));
  });

  it("preserves unknown fields losslessly", () => {
    const raw = JSON.stringify({
      type: "req",
      id: "5",
      method: "future.method",
      params: {},
      futureField: { nested: [1, 2, 3] },
      another: "kept",
    });
    const frame = decodeGatewayFrame(raw);
    expect(frame.type).toBe("req");
    if (frame.type !== "req") return;
    expect(frame.extra).toEqual({ futureField: { nested: [1, 2, 3] }, another: "kept" });
    // Re-encoded output must be byte-equivalent as JSON to the original.
    expect(JSON.parse(encodeGatewayFrame(frame))).toEqual(JSON.parse(raw));
  });

  it("rejects malformed frames with structured errors", () => {
    const cases = [
      "not json at all",
      JSON.stringify([1, 2, 3]),
      JSON.stringify({ type: "req", method: "m" }), // missing id
      JSON.stringify({ type: "req", id: "", method: "m" }), // empty id
      JSON.stringify({ type: "res", id: "1" }), // missing ok
      JSON.stringify({ type: "event" }), // missing event
      JSON.stringify({ type: "event", event: "x", seq: -1 }), // negative seq
      JSON.stringify({ type: "res", id: "1", ok: true, error: { message: "no code" } }),
      JSON.stringify({ type: "mystery", id: "1" }),
      JSON.stringify(null),
    ];
    for (const text of cases) {
      try {
        decodeGatewayFrame(text);
        expect.unreachable(`should have thrown for: ${text}`);
      } catch (e) {
        expect(e).toBeInstanceOf(GatewayFrameError);
        expect((e as GatewayFrameError).code).toBe("INVALID_REQUEST");
      }
    }
  });

  it("builds a connect request with shared-secret auth", () => {
    const text = buildConnectRequest("c1", {
      minProtocol: 4,
      maxProtocol: 4,
      client: { id: "omniharness-adapter", version: "0.1.0", platform: "node", mode: "backend" },
      auth: { token: "shared-secret" },
      role: "operator",
      scopes: ["operator.read", "operator.write"],
    });
    const frame = decodeGatewayFrame(text);
    expect(frame).toMatchObject({ type: "req", id: "c1", method: "connect" });
    if (frame.type !== "req") return;
    expect(frame.params).toMatchObject({
      minProtocol: 4,
      maxProtocol: 4,
      auth: { token: "shared-secret" },
    });
  });

  it("parses hello-ok payloads defensively", () => {
    const hello = parseHelloOk({
      type: "hello-ok",
      protocol: 4,
      server: { version: "2026.7.2", connId: "conn-1" },
      features: { methods: ["chat.send"], events: ["tick"], capabilities: ["x"] },
      snapshot: {},
      auth: { role: "operator", scopes: ["operator.read"], deviceToken: "dt-1" },
      policy: { maxPayload: 26214400, tickIntervalMs: 25000 },
      pluginSurfaceUrls: { a: "b" }, // unknown field ignored
    });
    expect(hello.protocol).toBe(4);
    expect(hello.server.connId).toBe("conn-1");
    expect(hello.auth.deviceToken).toBe("dt-1");
    expect(hello.policy?.maxPayload).toBe(26214400);
  });

  it("rejects malformed hello-ok", () => {
    const bad = [
      { type: "hello-ok" },
      { type: "hello-ok", protocol: 4, server: { version: "1" }, features: {}, auth: {} },
      {
        type: "hello-ok",
        protocol: "4",
        server: { version: "1", connId: "c" },
        features: { methods: [], events: [] },
        auth: { role: "operator", scopes: [] },
      },
      { type: "not-hello", protocol: 4 },
    ];
    for (const payload of bad) {
      expect(() => parseHelloOk(payload)).toThrow(GatewayFrameError);
    }
  });

  it("parses connect.challenge events", () => {
    const frame = decodeGatewayFrame(
      JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "n-1", ts: 123 },
      }),
    );
    expect(parseConnectChallenge(frame)).toEqual({ nonce: "n-1", ts: 123 });
    expect(() =>
      parseConnectChallenge(decodeGatewayFrame(JSON.stringify({ type: "event", event: "tick" }))),
    ).toThrow(GatewayFrameError);
  });
});
