/**
 * ChannelRouter — turns an inbound OpenClaw MsgContext-like message into a
 * normalized, authorized InboundMessage.
 *
 * Security invariants (ADR-0005):
 *  - Session keys are routing labels, never credentials. The router computes
 *    the session key itself from verified fields; any SessionKey arriving in
 *    the payload is ignored for authorization.
 *  - Every authorization decision is re-derived per message from the adapter
 *    config (allowlists, pairing state, dm/group policy).
 *  - Every decision is appended to the injected audit sink.
 */

import type { ProfileId, WorkspaceId } from "@omniharness/shared-types";
import { nowIso } from "@omniharness/shared-types";
import { noopAudit, stamp } from "./audit.js";
import type { AuditSink } from "./audit.js";
import {
  buildAgentMainSessionKey,
  buildAgentPeerSessionKey,
  appendThreadSuffix,
  parseSessionDeliveryRoute,
  DEFAULT_ACCOUNT_ID,
} from "./session-keys.js";
import type { DmScope, SessionDeliveryRoute } from "./session-keys.js";

export type DmPolicy = "pairing" | "allowlist" | "open" | "disabled";
export type GroupPolicy = "open" | "allowlist" | "disabled";
export type ChatType = "direct" | "group" | "channel";

/** Subset of upstream MsgContext (src/auto-reply/templating.ts) the adapter consumes. */
export interface MsgContextInput {
  Body: string;
  /** Channel peer address of the conversation (chat id / channel id). */
  From: string;
  To?: string;
  ChatType: ChatType;
  /** Channel kind, e.g. "telegram" | "slack" | "discord" | "whatsapp". */
  Provider: string;
  AccountId?: string;
  SenderId: string;
  SenderName?: string;
  SenderUsername?: string;
  SenderIsBot?: boolean;
  MessageThreadId?: string;
  /** UNTRUSTED routing hint from upstream. Ignored for authorization. */
  SessionKey?: string;
  media?: InboundMedia[];
}

export interface InboundMedia {
  mediaType: string;
  sizeBytes?: number;
  url?: string;
  path?: string;
}

export interface RouteTarget {
  profileId: ProfileId;
  workspaceId: WorkspaceId;
  agentId?: string;
  dmScope?: DmScope;
}

export interface ChannelAccountRule {
  channel: string;
  accountId?: string;
  dmPolicy: DmPolicy;
  /** Sender ids/usernames allowed to talk to the agent. "*" allows any sender. */
  allowFrom?: string[];
  /** Senders admitted through pairing (dmPolicy "pairing"). */
  pairedSenders?: string[];
  groupPolicy?: GroupPolicy;
  route: RouteTarget;
}

export interface RateLimitConfig {
  /** Max messages per window per sender. */
  capacity: number;
  refillPerSecond: number;
}

export interface RouterConfig {
  accounts: ChannelAccountRule[];
  rateLimit?: RateLimitConfig;
  /** Reject any single media item larger than this. */
  maxMediaBytes?: number;
}

export type DenyReason =
  | "unknown_account"
  | "channel_disabled"
  | "not_allowlisted"
  | "not_paired"
  | "media_too_large"
  | "rate_limited"
  | "invalid_message";

export interface InboundMessage {
  sessionKey: string;
  route: { profileId: ProfileId; workspaceId: WorkspaceId; agentId: string; dmScope: DmScope };
  channel: string;
  accountId: string;
  chatType: ChatType;
  senderId: string;
  senderName?: string;
  body: string;
  threadId?: string;
  media: InboundMedia[];
  deliveryRoute: SessionDeliveryRoute;
  receivedAt: string;
}

export type RouteResult =
  | { ok: true; message: InboundMessage }
  | { ok: false; reason: DenyReason; detail: string };

class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;
  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    nowMs: number,
  ) {
    this.tokens = capacity;
    this.lastRefillMs = nowMs;
  }
  tryConsume(nowMs: number): boolean {
    const elapsed = Math.max(0, nowMs - this.lastRefillMs);
    this.tokens = Math.min(this.capacity, this.tokens + (elapsed / 1000) * this.refillPerSecond);
    this.lastRefillMs = nowMs;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}

function senderMatches(list: readonly string[], senderId: string, senderUsername?: string): boolean {
  const id = senderId.trim().toLowerCase();
  const user = senderUsername?.trim().toLowerCase();
  for (const entry of list) {
    const e = entry.trim().toLowerCase();
    if (e === "*") return true;
    if (e === id) return true;
    if (user && (e === user || e === `@${user}`)) return true;
  }
  return false;
}

export class ChannelRouter {
  private readonly buckets = new Map<string, TokenBucket>();
  private readonly audit: AuditSink;
  private readonly now: () => number;

  constructor(
    private readonly config: RouterConfig,
    deps: { audit?: AuditSink; now?: () => number } = {},
  ) {
    this.audit = deps.audit ?? noopAudit;
    this.now = deps.now ?? (() => Date.now());
  }

  private findRule(channel: string, accountId: string): ChannelAccountRule | undefined {
    return this.config.accounts.find(
      (r) =>
        r.channel.toLowerCase() === channel.toLowerCase() &&
        (r.accountId ?? DEFAULT_ACCOUNT_ID).toLowerCase() === accountId.toLowerCase(),
    );
  }

  private deny(
    reason: DenyReason,
    detail: string,
    ctx: { channel: string; accountId: string; senderId: string },
  ): RouteResult {
    this.audit(
      stamp({
        kind: "authz.decision",
        channel: ctx.channel,
        accountId: ctx.accountId,
        senderId: ctx.senderId,
        allowed: false,
        reason,
      }),
    );
    return { ok: false, reason, detail };
  }

  route(raw: MsgContextInput): RouteResult {
    const channel = (raw.Provider ?? "").trim().toLowerCase();
    const accountId = (raw.AccountId ?? DEFAULT_ACCOUNT_ID).trim().toLowerCase() || DEFAULT_ACCOUNT_ID;
    const senderId = (raw.SenderId ?? "").trim();
    const ctx = { channel, accountId, senderId };

    this.audit(
      stamp({
        kind: "inbound.received",
        channel,
        accountId,
        senderId,
        chatType: raw.ChatType,
        bodyBytes: (raw.Body ?? "").length,
      }),
    );

    if (!channel || !senderId || typeof raw.Body !== "string" || !raw.From) {
      return this.deny("invalid_message", "missing Provider/SenderId/Body/From", ctx);
    }

    const rule = this.findRule(channel, accountId);
    if (!rule) {
      return this.deny("unknown_account", `no route configured for ${channel}/${accountId}`, ctx);
    }

    // Media size limit (default 25 MiB, mirroring gateway MAX_PAYLOAD_BYTES).
    const maxMediaBytes = this.config.maxMediaBytes ?? 25 * 1024 * 1024;
    for (const m of raw.media ?? []) {
      const size = m.sizeBytes ?? 0;
      if (size > maxMediaBytes) {
        this.audit(
          stamp({
            kind: "media_rejected",
            channel,
            accountId,
            senderId,
            mediaType: m.mediaType,
            sizeBytes: size,
            maxBytes: maxMediaBytes,
          }),
        );
        return this.deny(
          "media_too_large",
          `media ${m.mediaType} is ${size} bytes, limit ${maxMediaBytes}`,
          ctx,
        );
      }
    }

    // Authorization, re-derived per message. raw.SessionKey is deliberately
    // NOT consulted: it is attacker-controllable routing metadata.
    const allowFrom = rule.allowFrom ?? [];
    if (raw.ChatType === "direct") {
      switch (rule.dmPolicy) {
        case "disabled":
          return this.deny("channel_disabled", "DMs disabled for this account", ctx);
        case "open":
          break;
        case "allowlist":
          if (!senderMatches(allowFrom, senderId, raw.SenderUsername)) {
            return this.deny("not_allowlisted", "sender not in allowlist", ctx);
          }
          break;
        case "pairing": {
          const paired = rule.pairedSenders ?? [];
          if (
            !senderMatches(allowFrom, senderId, raw.SenderUsername) &&
            !senderMatches(paired, senderId, raw.SenderUsername)
          ) {
            return this.deny("not_paired", "sender is neither allowlisted nor paired", ctx);
          }
          break;
        }
      }
    } else {
      const groupPolicy = rule.groupPolicy ?? "allowlist";
      switch (groupPolicy) {
        case "disabled":
          return this.deny("channel_disabled", "group messages disabled for this account", ctx);
        case "open":
          break;
        case "allowlist":
          if (!senderMatches(allowFrom, senderId, raw.SenderUsername)) {
            return this.deny("not_allowlisted", "sender not in group allowlist", ctx);
          }
          break;
      }
    }

    // Rate limit (per channel+account+sender).
    const rl = this.config.rateLimit;
    if (rl) {
      const key = `${channel}:${accountId}:${senderId.toLowerCase()}`;
      let bucket = this.buckets.get(key);
      if (!bucket) {
        bucket = new TokenBucket(rl.capacity, rl.refillPerSecond, this.now());
        this.buckets.set(key, bucket);
      }
      if (!bucket.tryConsume(this.now())) {
        this.audit(stamp({ kind: "rate_limited", channel, accountId, senderId }));
        return this.deny("rate_limited", "sender rate limit exceeded", ctx);
      }
    }

    // Compute the routing identity ourselves from verified fields.
    const agentId = rule.route.agentId ?? "main";
    const dmScope = rule.route.dmScope ?? "per-account-channel-peer";
    const peerId = raw.ChatType === "direct" ? senderId : raw.From;
    const baseKey =
      raw.ChatType === "direct" && dmScope === "main"
        ? buildAgentMainSessionKey({ agentId })
        : buildAgentPeerSessionKey({
            agentId,
            channel,
            accountId,
            peerKind: raw.ChatType,
            peerId,
            dmScope,
          });
    const sessionKey = raw.MessageThreadId
      ? appendThreadSuffix(baseKey, raw.MessageThreadId)
      : baseKey;

    const deliveryRoute = parseSessionDeliveryRoute(sessionKey);
    if (!deliveryRoute) {
      return this.deny("invalid_message", "could not derive delivery route", ctx);
    }

    this.audit(
      stamp({
        kind: "authz.decision",
        channel,
        accountId,
        senderId,
        allowed: true,
        reason: "allowed",
        sessionKey,
      }),
    );

    const message: InboundMessage = {
      sessionKey,
      route: {
        profileId: rule.route.profileId,
        workspaceId: rule.route.workspaceId,
        agentId,
        dmScope,
      },
      channel,
      accountId,
      chatType: raw.ChatType,
      senderId,
      body: raw.Body,
      media: raw.media ?? [],
      deliveryRoute,
      receivedAt: nowIso(),
    };
    if (raw.SenderName) message.senderName = raw.SenderName;
    if (raw.MessageThreadId) message.threadId = raw.MessageThreadId;
    return { ok: true, message };
  }
}
