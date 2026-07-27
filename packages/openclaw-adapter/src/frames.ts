/**
 * Pure codec for OpenClaw gateway wire frames (protocol v4).
 *
 * Mirrors the shapes in upstream `packages/gateway-protocol/src/schema/frames.ts`
 * (audited @ cca67fc8): WS text frames carrying JSON, a discriminated union on
 * `"type"`: req / res / event. This module does NO network I/O — it only
 * encodes and defensively decodes.
 *
 * Defensive parsing rules:
 *  - unknown top-level fields are preserved (round-tripped via `extra`);
 *  - malformed frames are rejected with a structured `GatewayFrameError`,
 *    never a raw SyntaxError or a silently-coerced object.
 */

/** Pinned upstream protocol constants (packages/gateway-protocol/src/version.ts). */
export const OPENCLAW_PROTOCOL_VERSION = 4;
export const OPENCLAW_MIN_CLIENT_PROTOCOL_VERSION = 4;
export const OPENCLAW_MIN_NODE_PROTOCOL_VERSION = 3;
export const OPENCLAW_DEFAULT_GATEWAY_PORT = 18789;

/** Error codes used by the gateway (src/schema/error-codes.ts), plus codec-local ones. */
export const GatewayErrorCodes = {
  INVALID_REQUEST: "INVALID_REQUEST",
  NOT_PAIRED: "NOT_PAIRED",
  UNAVAILABLE: "UNAVAILABLE",
  FORBIDDEN: "FORBIDDEN",
  UNAUTHORIZED: "UNAUTHORIZED",
  NOT_FOUND: "NOT_FOUND",
  RATE_LIMITED: "RATE_LIMITED",
  INTERNAL: "INTERNAL",
} as const;
export type GatewayErrorCode = (typeof GatewayErrorCodes)[keyof typeof GatewayErrorCodes];

export interface ErrorShape {
  code: string;
  message: string;
  details?: unknown;
  retryable?: boolean;
  retryAfterMs?: number;
}

export interface RequestFrame {
  type: "req";
  id: string;
  method: string;
  params?: unknown;
  /** Unknown fields from the wire, preserved verbatim for re-encode. */
  extra?: Record<string, unknown>;
}

export interface ResponseFrame {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: ErrorShape;
  extra?: Record<string, unknown>;
}

export interface EventFrame {
  type: "event";
  event: string;
  payload?: unknown;
  seq?: number;
  stateVersion?: number;
  extra?: Record<string, unknown>;
}

export type GatewayFrame = RequestFrame | ResponseFrame | EventFrame;

export class GatewayFrameError extends Error {
  constructor(
    public readonly code: GatewayErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "GatewayFrameError";
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function parseErrorShape(v: unknown, ctx: string): ErrorShape | undefined {
  if (v === undefined) return undefined;
  if (!isRecord(v) || !isNonEmptyString(v["code"]) || !isNonEmptyString(v["message"])) {
    throw new GatewayFrameError(GatewayErrorCodes.INVALID_REQUEST, `${ctx}: malformed error shape`);
  }
  const out: ErrorShape = { code: v["code"], message: v["message"] };
  if ("details" in v) out.details = v["details"];
  if (typeof v["retryable"] === "boolean") out.retryable = v["retryable"];
  if (typeof v["retryAfterMs"] === "number") out.retryAfterMs = v["retryAfterMs"];
  return out;
}

/** Collect fields not part of the known schema so re-encoding is lossless. */
function collectExtra(raw: Record<string, unknown>, known: readonly string[]): Record<string, unknown> | undefined {
  const knownSet = new Set(known);
  const extra: Record<string, unknown> = {};
  let count = 0;
  for (const [k, v] of Object.entries(raw)) {
    if (!knownSet.has(k)) {
      extra[k] = v;
      count += 1;
    }
  }
  return count > 0 ? extra : undefined;
}

/** Decode one WS text frame into a typed gateway frame. Throws GatewayFrameError. */
export function decodeGatewayFrame(text: string): GatewayFrame {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new GatewayFrameError(
      GatewayErrorCodes.INVALID_REQUEST,
      `frame is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new GatewayFrameError(GatewayErrorCodes.INVALID_REQUEST, "frame must be a JSON object");
  }
  const type = parsed["type"];
  if (type === "req") {
    if (!isNonEmptyString(parsed["id"]) || !isNonEmptyString(parsed["method"])) {
      throw new GatewayFrameError(GatewayErrorCodes.INVALID_REQUEST, "req frame requires non-empty id and method");
    }
    const frame: RequestFrame = { type: "req", id: parsed["id"], method: parsed["method"] };
    if ("params" in parsed) frame.params = parsed["params"];
    const extra = collectExtra(parsed, ["type", "id", "method", "params"]);
    if (extra) frame.extra = extra;
    return frame;
  }
  if (type === "res") {
    if (!isNonEmptyString(parsed["id"]) || typeof parsed["ok"] !== "boolean") {
      throw new GatewayFrameError(GatewayErrorCodes.INVALID_REQUEST, "res frame requires non-empty id and boolean ok");
    }
    const frame: ResponseFrame = { type: "res", id: parsed["id"], ok: parsed["ok"] };
    if ("payload" in parsed) frame.payload = parsed["payload"];
    const error = parseErrorShape(parsed["error"], "res frame");
    if (error) frame.error = error;
    const extra = collectExtra(parsed, ["type", "id", "ok", "payload", "error"]);
    if (extra) frame.extra = extra;
    return frame;
  }
  if (type === "event") {
    if (!isNonEmptyString(parsed["event"])) {
      throw new GatewayFrameError(GatewayErrorCodes.INVALID_REQUEST, "event frame requires non-empty event name");
    }
    const frame: EventFrame = { type: "event", event: parsed["event"] };
    if ("payload" in parsed) frame.payload = parsed["payload"];
    if (parsed["seq"] !== undefined) {
      if (typeof parsed["seq"] !== "number" || !Number.isInteger(parsed["seq"]) || parsed["seq"] < 0) {
        throw new GatewayFrameError(GatewayErrorCodes.INVALID_REQUEST, "event frame seq must be a non-negative integer");
      }
      frame.seq = parsed["seq"];
    }
    if (typeof parsed["stateVersion"] === "number") frame.stateVersion = parsed["stateVersion"];
    const extra = collectExtra(parsed, ["type", "event", "payload", "seq", "stateVersion"]);
    if (extra) frame.extra = extra;
    return frame;
  }
  throw new GatewayFrameError(
    GatewayErrorCodes.INVALID_REQUEST,
    `unknown frame type: ${typeof type === "string" ? type : typeof type}`,
  );
}

/** Encode a frame back to a WS text frame, preserving previously-unknown fields. */
export function encodeGatewayFrame(frame: GatewayFrame): string {
  const { extra, ...known } = frame;
  return JSON.stringify({ ...(extra ?? {}), ...known });
}

export function encodeRequest(id: string, method: string, params?: unknown): string {
  const frame: RequestFrame = { type: "req", id, method };
  if (params !== undefined) frame.params = params;
  return encodeGatewayFrame(frame);
}

export function encodeEvent(event: string, payload?: unknown, seq?: number): string {
  const frame: EventFrame = { type: "event", event };
  if (payload !== undefined) frame.payload = payload;
  if (seq !== undefined) frame.seq = seq;
  return encodeGatewayFrame(frame);
}

// ── handshake shapes ─────────────────────────────────────────────────────────

/** Subset of upstream ConnectParamsSchema we ever send (client side). */
export interface ConnectParams {
  minProtocol: number;
  maxProtocol: number;
  client: {
    id: string;
    displayName?: string;
    version: string;
    platform: string;
    deviceFamily?: string;
    modelIdentifier?: string;
    mode: string;
    instanceId?: string;
  };
  caps?: string[];
  commands?: string[];
  role?: string;
  scopes?: string[];
  auth?: {
    token?: string;
    deviceToken?: string;
    password?: string;
  };
  locale?: string;
  userAgent?: string;
}

export function buildConnectRequest(id: string, params: ConnectParams): string {
  return encodeRequest(id, "connect", params);
}

/** Parsed hello-ok payload (success response to `connect`). */
export interface HelloOk {
  type: "hello-ok";
  protocol: number;
  server: { version: string; connId: string };
  features: { methods: string[]; events: string[]; capabilities?: string[] };
  auth: {
    deviceToken?: string;
    role: string;
    scopes: string[];
  };
  policy?: { maxPayload?: number; maxBufferedBytes?: number; tickIntervalMs?: number };
}

function asStringArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== "string") return null;
    out.push(item);
  }
  return out;
}

/** Defensively parse a hello-ok payload. Throws GatewayFrameError. */
export function parseHelloOk(payload: unknown): HelloOk {
  if (!isRecord(payload) || payload["type"] !== "hello-ok") {
    throw new GatewayFrameError(GatewayErrorCodes.INVALID_REQUEST, "hello-ok payload expected");
  }
  const server = payload["server"];
  const features = payload["features"];
  const auth = payload["auth"];
  if (typeof payload["protocol"] !== "number" || !Number.isInteger(payload["protocol"])) {
    throw new GatewayFrameError(GatewayErrorCodes.INVALID_REQUEST, "hello-ok: protocol must be an integer");
  }
  if (!isRecord(server) || !isNonEmptyString(server["version"]) || !isNonEmptyString(server["connId"])) {
    throw new GatewayFrameError(GatewayErrorCodes.INVALID_REQUEST, "hello-ok: malformed server block");
  }
  if (!isRecord(features)) {
    throw new GatewayFrameError(GatewayErrorCodes.INVALID_REQUEST, "hello-ok: malformed features block");
  }
  const methods = asStringArray(features["methods"]);
  const events = asStringArray(features["events"]);
  if (!methods || !events) {
    throw new GatewayFrameError(GatewayErrorCodes.INVALID_REQUEST, "hello-ok: features.methods/events must be string arrays");
  }
  if (!isRecord(auth) || !isNonEmptyString(auth["role"])) {
    throw new GatewayFrameError(GatewayErrorCodes.INVALID_REQUEST, "hello-ok: malformed auth block");
  }
  const scopes = asStringArray(auth["scopes"]);
  if (!scopes) {
    throw new GatewayFrameError(GatewayErrorCodes.INVALID_REQUEST, "hello-ok: auth.scopes must be a string array");
  }
  const hello: HelloOk = {
    type: "hello-ok",
    protocol: payload["protocol"],
    server: { version: server["version"], connId: server["connId"] },
    features: { methods, events },
    auth: { role: auth["role"], scopes },
  };
  const caps = asStringArray(features["capabilities"]);
  if (caps) hello.features = { ...hello.features, capabilities: caps };
  if (typeof auth["deviceToken"] === "string") hello.auth = { ...hello.auth, deviceToken: auth["deviceToken"] };
  const policy = payload["policy"];
  if (isRecord(policy)) {
    const p: NonNullable<HelloOk["policy"]> = {};
    if (typeof policy["maxPayload"] === "number") p.maxPayload = policy["maxPayload"];
    if (typeof policy["maxBufferedBytes"] === "number") p.maxBufferedBytes = policy["maxBufferedBytes"];
    if (typeof policy["tickIntervalMs"] === "number") p.tickIntervalMs = policy["tickIntervalMs"];
    hello.policy = p;
  }
  return hello;
}

/** Typed view of the connect.challenge event payload. */
export interface ConnectChallenge {
  nonce: string;
  ts: number;
}

export function parseConnectChallenge(frame: GatewayFrame): ConnectChallenge {
  if (frame.type !== "event" || frame.event !== "connect.challenge" || !isRecord(frame.payload)) {
    throw new GatewayFrameError(GatewayErrorCodes.INVALID_REQUEST, "expected connect.challenge event frame");
  }
  const payload = frame.payload;
  if (!isNonEmptyString(payload["nonce"]) || typeof payload["ts"] !== "number") {
    throw new GatewayFrameError(GatewayErrorCodes.INVALID_REQUEST, "malformed connect.challenge payload");
  }
  return { nonce: payload["nonce"], ts: payload["ts"] };
}
