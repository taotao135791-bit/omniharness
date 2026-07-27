/**
 * OpenClaw session key codec.
 *
 * Session keys are durable ROUTING identities — never credentials. Canonical
 * format `agent:<agentId>:<rest>` (upstream src/routing/session-key.ts,
 * src/sessions/session-key-utils.ts, audited @ cca67fc8):
 *
 *   main:                        agent:<agentId>:main
 *   group/channel peer:          agent:<id>:<channel>:<group|channel>:<peerId>
 *   DM, dmScope per-channel-peer:        agent:<id>:<channel>:direct:<peerId>
 *   DM, dmScope per-account-channel-peer: agent:<id>:<channel>:<accountId>:direct:<peerId>
 *   DM, dmScope per-peer:                agent:<id>:direct:<peerId>
 *   thread suffix:               <base>:thread:<threadId>
 *
 * Keys are lowercased EXCEPT provider-opaque case-sensitive spans
 * (CASE_PRESERVING_PEERS: signal group ids, matrix room ids).
 */

import type { ProfileId, SessionId } from "@omniharness/shared-types";

export const DEFAULT_AGENT_ID = "main";
export const DEFAULT_MAIN_KEY = "main";
export const DEFAULT_ACCOUNT_ID = "default";

export type DmScope = "main" | "per-peer" | "per-channel-peer" | "per-account-channel-peer";
export type PeerKind = "direct" | "group" | "channel";

export class SessionKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionKeyError";
  }
}

const PEER_KINDS: ReadonlySet<string> = new Set(["direct", "dm", "group", "channel"]);

/** Channels whose peer ids are opaque and case-sensitive (upstream #75670/#82853). */
const CASE_PRESERVING_PEERS: ReadonlyArray<{ channel: string; peerKinds: ReadonlySet<string> }> = [
  { channel: "signal", peerKinds: new Set(["group"]) },
  { channel: "matrix", peerKinds: new Set(["channel", "group"]) },
];

function isCasePreservingPeer(channel: string, peerKind: string): boolean {
  const c = channel.toLowerCase();
  const k = peerKind.toLowerCase();
  return CASE_PRESERVING_PEERS.some((d) => d.channel === c && d.peerKinds.has(k));
}

function normalizeSegment(value: string, what: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new SessionKeyError(`${what} must be non-empty`);
  if (trimmed.includes(":")) throw new SessionKeyError(`${what} must not contain ':'`);
  return trimmed.toLowerCase();
}

function normalizeAgentId(value: string | undefined): string {
  return normalizeSegment(value ?? DEFAULT_AGENT_ID, "agentId");
}

function normalizeAccountId(value: string | null | undefined): string {
  const trimmed = (value ?? "").trim();
  return trimmed ? trimmed.toLowerCase() : DEFAULT_ACCOUNT_ID;
}

/** Peer ids keep case for channels with opaque case-sensitive ids; else lowercase. */
export function normalizeSessionPeerId(params: { channel: string; peerKind: PeerKind; peerId: string }): string {
  const peerId = params.peerId.trim();
  if (!peerId) return "";
  if (isCasePreservingPeer(params.channel, params.peerKind)) return peerId;
  return peerId.toLowerCase();
}

export function buildAgentMainSessionKey(params: { agentId?: string; mainKey?: string }): string {
  const agentId = normalizeAgentId(params.agentId);
  const mainKey = normalizeSegment(params.mainKey ?? DEFAULT_MAIN_KEY, "mainKey");
  return `agent:${agentId}:${mainKey}`;
}

export function buildAgentPeerSessionKey(params: {
  agentId?: string;
  channel: string;
  accountId?: string | null;
  peerKind: PeerKind;
  peerId: string;
  dmScope?: DmScope;
  /** channel-peerId → canonical identity links (session.identityLinks). */
  identityLinks?: Record<string, string[]>;
}): string {
  const agentId = normalizeAgentId(params.agentId);
  const channel = normalizeSegment(params.channel, "channel");
  const peerKind = params.peerKind;

  if (peerKind === "direct") {
    const dmScope = params.dmScope ?? "main";
    let peerId = params.peerId.trim();
    if (dmScope === "main") {
      return buildAgentMainSessionKey({ agentId });
    }
    const linked = resolveLinkedPeerId(params.identityLinks, channel, peerId);
    if (linked) peerId = linked;
    peerId = normalizeSessionPeerId({ channel, peerKind, peerId });
    if (!peerId) throw new SessionKeyError("peerId must be non-empty");
    if (dmScope === "per-account-channel-peer") {
      const accountId = normalizeAccountId(params.accountId);
      return `agent:${agentId}:${channel}:${accountId}:direct:${peerId}`;
    }
    if (dmScope === "per-channel-peer") {
      return `agent:${agentId}:${channel}:direct:${peerId}`;
    }
    // per-peer
    return `agent:${agentId}:direct:${peerId}`;
  }

  const peerId = normalizeSessionPeerId({ channel, peerKind, peerId: params.peerId });
  if (!peerId) throw new SessionKeyError("peerId must be non-empty");
  return `agent:${agentId}:${channel}:${peerKind}:${peerId}`;
}

function resolveLinkedPeerId(
  identityLinks: Record<string, string[]> | undefined,
  channel: string,
  peerId: string,
): string | null {
  if (!identityLinks || !peerId) return null;
  const candidates = new Set<string>([peerId.toLowerCase(), `${channel}:${peerId}`.toLowerCase()]);
  for (const [canonical, ids] of Object.entries(identityLinks)) {
    if (!canonical.trim() || !Array.isArray(ids)) continue;
    for (const id of ids) {
      if (candidates.has(id.trim().toLowerCase())) return canonical.trim().toLowerCase();
    }
  }
  return null;
}

export function appendThreadSuffix(baseSessionKey: string, threadId: string): string {
  const t = threadId.trim().toLowerCase();
  if (!t) throw new SessionKeyError("threadId must be non-empty");
  return `${baseSessionKey}:thread:${t}`;
}

export interface ParsedAgentSessionKey {
  agentId: string;
  rest: string;
}

export function parseAgentSessionKey(sessionKey: string): ParsedAgentSessionKey | null {
  const raw = sessionKey.trim();
  if (!raw) return null;
  const parts = raw.split(":");
  if (parts.length < 3 || parts[0] !== "agent") return null;
  const agentId = parts[1]?.trim();
  const rest = parts.slice(2).join(":");
  if (!agentId || !rest) return null;
  return { agentId, rest };
}

export interface ParsedThreadSuffix {
  baseSessionKey: string;
  threadId?: string;
}

export function parseThreadSessionSuffix(sessionKey: string): ParsedThreadSuffix {
  const idx = sessionKey.toLowerCase().lastIndexOf(":thread:");
  if (idx === -1) return { baseSessionKey: sessionKey };
  const threadId = sessionKey.slice(idx + ":thread:".length).trim();
  if (!threadId) return { baseSessionKey: sessionKey };
  return { baseSessionKey: sessionKey.slice(0, idx), threadId };
}

export function isAcpSessionKey(sessionKey: string): boolean {
  const raw = sessionKey.trim().toLowerCase();
  if (raw.startsWith("acp:")) return true;
  return parseAgentSessionKey(raw)?.rest.startsWith("acp:") === true;
}

export function isCronSessionKey(sessionKey: string): boolean {
  return parseAgentSessionKey(sessionKey.trim().toLowerCase())?.rest.startsWith("cron:") === true;
}

/** Reverse-parsed delivery route (outbound addressing). Routing metadata only. */
export interface SessionDeliveryRoute {
  channel: string;
  accountId?: string;
  peerKind: PeerKind | "dm";
  peerId: string;
  threadId?: string;
}

export function parseSessionDeliveryRoute(sessionKey: string): SessionDeliveryRoute | null {
  const parsedThread = parseThreadSessionSuffix(sessionKey);
  const parsed = parseAgentSessionKey(parsedThread.baseSessionKey);
  if (!parsed) return null;
  const parts = parsed.rest.split(":");
  if (parts[0] === "agent" || parts.length < 2) return null;

  // DM without channel segment: agent:<id>:direct:<peerId>
  if (parts[0] === "direct" || parts[0] === "dm") {
    const peerId = parts.slice(1).join(":").trim();
    if (!peerId || parts.length < 2) return null;
    const route: SessionDeliveryRoute = { channel: "", peerKind: parts[0] as PeerKind | "dm", peerId };
    if (parsedThread.threadId) route.threadId = parsedThread.threadId;
    return route;
  }

  if (parts.length < 3) return null;
  const channel = parts[0]?.trim().toLowerCase();
  if (!channel) return null;

  // per-account DM: agent:<id>:<channel>:<accountId>:direct:<peerId>
  if (parts.length >= 4 && (parts[2] === "direct" || parts[2] === "dm")) {
    const accountId = parts[1]?.trim();
    const peerId = parts.slice(3).join(":").trim();
    if (!accountId || !peerId) return null;
    const route: SessionDeliveryRoute = {
      channel,
      accountId,
      peerKind: parts[2] as PeerKind | "dm",
      peerId,
    };
    if (parsedThread.threadId) route.threadId = parsedThread.threadId;
    return route;
  }

  const peerKind = parts[1];
  const peerId = parts.slice(2).join(":").trim();
  if (!peerKind || !PEER_KINDS.has(peerKind) || !peerId) return null;
  const route: SessionDeliveryRoute = { channel, peerKind: peerKind as PeerKind | "dm", peerId };
  if (parsedThread.threadId) route.threadId = parsedThread.threadId;
  return route;
}

// ── OmniHarness mapping ─────────────────────────────────────────────────────

export interface SessionKeyMapping {
  sessionKey: string;
  sessionId: SessionId;
  profileId: ProfileId;
  /** Channel delivery target for replies/approvals, when this session is channel-owned. */
  deliveryRoute?: SessionDeliveryRoute;
}

/**
 * Bidirectional, in-memory mapping between OpenClaw session keys (routing
 * labels) and OmniHarness sessions. The key is NEVER an authority: it only
 * selects which OmniHarness session a verified route continues in.
 */
export class SessionKeyMap {
  private readonly byKey = new Map<string, SessionKeyMapping>();
  private readonly bySessionId = new Map<SessionId, SessionKeyMapping>();

  get(sessionKey: string): SessionKeyMapping | undefined {
    return this.byKey.get(sessionKey);
  }

  getBySessionId(sessionId: SessionId): SessionKeyMapping | undefined {
    return this.bySessionId.get(sessionId);
  }

  register(mapping: SessionKeyMapping): void {
    this.byKey.set(mapping.sessionKey, mapping);
    this.bySessionId.set(mapping.sessionId, mapping);
  }

  remove(sessionKey: string): boolean {
    const m = this.byKey.get(sessionKey);
    if (!m) return false;
    this.byKey.delete(sessionKey);
    this.bySessionId.delete(m.sessionId);
    return true;
  }

  get size(): number {
    return this.byKey.size;
  }
}
