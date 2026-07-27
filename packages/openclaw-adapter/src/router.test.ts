import { describe, expect, it } from "vitest";
import type { ProfileId, WorkspaceId } from "@omniharness/shared-types";
import { collectingAudit } from "./audit.js";
import { ChannelRouter } from "./router.js";
import type { MsgContextInput, RouterConfig } from "./router.js";

const PROF = "prof-1" as ProfileId;
const WS = "ws-1" as WorkspaceId;

function config(overrides: Partial<RouterConfig> = {}): RouterConfig {
  return {
    accounts: [
      {
        channel: "telegram",
        dmPolicy: "allowlist",
        allowFrom: ["alice", "@bob"],
        route: { profileId: PROF, workspaceId: WS },
      },
      {
        channel: "slack",
        accountId: "team1",
        dmPolicy: "pairing",
        allowFrom: ["owner"],
        pairedSenders: ["carol"],
        route: { profileId: PROF, workspaceId: WS, agentId: "work" },
      },
    ],
    ...overrides,
  };
}

function msg(overrides: Partial<MsgContextInput> = {}): MsgContextInput {
  return {
    Provider: "telegram",
    AccountId: "default",
    From: "alice",
    ChatType: "direct",
    SenderId: "alice",
    Body: "hello",
    ...overrides,
  };
}

describe("ChannelRouter", () => {
  it("allows an allowlisted sender and computes the session key itself", () => {
    const router = new ChannelRouter(config());
    const result = router.route(msg());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.message.sessionKey).toBe("agent:main:telegram:default:direct:alice");
    expect(result.message.route.profileId).toBe(PROF);
    expect(result.message.deliveryRoute).toMatchObject({ channel: "telegram", peerId: "alice" });
  });

  it("matches usernames in the allowlist", () => {
    const router = new ChannelRouter(config());
    const result = router.route(msg({ SenderId: "999", SenderUsername: "bob" }));
    expect(result.ok).toBe(true);
  });

  it("denies senders not in the allowlist", () => {
    const router = new ChannelRouter(config());
    const result = router.route(msg({ From: "mallory", SenderId: "mallory" }));
    expect(result).toMatchObject({ ok: false, reason: "not_allowlisted" });
  });

  it("denies unknown channel accounts", () => {
    const router = new ChannelRouter(config());
    expect(router.route(msg({ Provider: "discord" }))).toMatchObject({ ok: false, reason: "unknown_account" });
    expect(router.route(msg({ Provider: "slack", AccountId: "other" }))).toMatchObject({
      ok: false,
      reason: "unknown_account",
    });
  });

  it("pairing policy: allows paired senders, denies unpaired", () => {
    const router = new ChannelRouter(config());
    const paired = router.route(msg({ Provider: "slack", AccountId: "team1", From: "carol", SenderId: "carol" }));
    expect(paired.ok).toBe(true);
    if (paired.ok) {
      expect(paired.message.sessionKey).toBe("agent:work:slack:team1:direct:carol");
    }
    const unpaired = router.route(msg({ Provider: "slack", AccountId: "team1", From: "dave", SenderId: "dave" }));
    expect(unpaired).toMatchObject({ ok: false, reason: "not_paired" });
  });

  it("A FORGED SESSION KEY DOES NOT BYPASS THE ALLOWLIST", () => {
    const { sink, events } = collectingAudit();
    const router = new ChannelRouter(config(), { audit: sink });
    // Attacker presents the main session key of a privileged session.
    const forged = router.route(
      msg({ From: "mallory", SenderId: "mallory", SessionKey: "agent:main:main" }),
    );
    expect(forged).toMatchObject({ ok: false, reason: "not_allowlisted" });
    const decisions = events.filter((e) => e.kind === "authz.decision");
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ allowed: false, reason: "not_allowlisted", senderId: "mallory" });
  });

  it("ignores a forged SessionKey even for allowed senders (key is recomputed)", () => {
    const router = new ChannelRouter(config());
    const result = router.route(msg({ SessionKey: "agent:main:main" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.message.sessionKey).not.toBe("agent:main:main");
    expect(result.message.sessionKey).toBe("agent:main:telegram:default:direct:alice");
  });

  it("rate limits per sender with a token bucket", () => {
    let nowMs = 1_000_000;
    const router = new ChannelRouter(
      config({ rateLimit: { capacity: 2, refillPerSecond: 1 } }),
      { now: () => nowMs },
    );
    expect(router.route(msg()).ok).toBe(true);
    expect(router.route(msg()).ok).toBe(true);
    expect(router.route(msg())).toMatchObject({ ok: false, reason: "rate_limited" });
    // A different sender has an independent bucket.
    expect(router.route(msg({ From: "999", SenderId: "999", SenderUsername: "bob" })).ok).toBe(true);
    // After 1.5s, ~1.5 tokens refilled (capped at capacity).
    nowMs += 1500;
    expect(router.route(msg()).ok).toBe(true);
  });

  it("rejects oversized media", () => {
    const { sink, events } = collectingAudit();
    const router = new ChannelRouter(config({ maxMediaBytes: 1024 }), { audit: sink });
    const result = router.route(msg({ media: [{ mediaType: "image/png", sizeBytes: 2048, url: "file://x" }] }));
    expect(result).toMatchObject({ ok: false, reason: "media_too_large" });
    expect(events.some((e) => e.kind === "media_rejected" && e.sizeBytes === 2048)).toBe(true);
  });

  it("emits audit records for inbound + authz decisions", () => {
    const { sink, events } = collectingAudit();
    const router = new ChannelRouter(config(), { audit: sink });
    router.route(msg());
    expect(events.some((e) => e.kind === "inbound.received" && e.senderId === "alice")).toBe(true);
    expect(events.some((e) => e.kind === "authz.decision" && e.allowed)).toBe(true);
  });

  it("denies when dmPolicy is disabled", () => {
    const router = new ChannelRouter(
      config({
        accounts: [
          { channel: "telegram", dmPolicy: "disabled", allowFrom: ["*"], route: { profileId: PROF, workspaceId: WS } },
        ],
      }),
    );
    expect(router.route(msg())).toMatchObject({ ok: false, reason: "channel_disabled" });
  });

  it("routes group messages by group policy and thread", () => {
    const router = new ChannelRouter(
      config({
        accounts: [
          {
            channel: "telegram",
            dmPolicy: "allowlist",
            allowFrom: ["alice"],
            groupPolicy: "open",
            route: { profileId: PROF, workspaceId: WS },
          },
        ],
      }),
    );
    const result = router.route(
      msg({ ChatType: "group", From: "-10099", SenderId: "anyone", MessageThreadId: "T5" }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.message.sessionKey).toBe("agent:main:telegram:group:-10099:thread:t5");
  });

  it("rejects structurally invalid messages", () => {
    const router = new ChannelRouter(config());
    expect(router.route(msg({ SenderId: "" }))).toMatchObject({ ok: false, reason: "invalid_message" });
  });
});
