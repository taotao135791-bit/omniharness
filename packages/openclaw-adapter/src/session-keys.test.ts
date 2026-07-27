import { describe, expect, it } from "vitest";
import type { ProfileId, SessionId } from "@omniharness/shared-types";
import {
  SessionKeyError,
  SessionKeyMap,
  appendThreadSuffix,
  buildAgentMainSessionKey,
  buildAgentPeerSessionKey,
  isAcpSessionKey,
  isCronSessionKey,
  normalizeSessionPeerId,
  parseAgentSessionKey,
  parseSessionDeliveryRoute,
  parseThreadSessionSuffix,
} from "./session-keys.js";

describe("session key codec", () => {
  it("builds main keys", () => {
    expect(buildAgentMainSessionKey({})).toBe("agent:main:main");
    expect(buildAgentMainSessionKey({ agentId: "Work", mainKey: "primary" })).toBe("agent:work:primary");
  });

  it("builds DM keys for every dmScope", () => {
    const base = { agentId: "main", channel: "Telegram", accountId: "Biz", peerKind: "direct" as const, peerId: "Alice" };
    expect(buildAgentPeerSessionKey({ ...base, dmScope: "per-account-channel-peer" })).toBe(
      "agent:main:telegram:biz:direct:alice",
    );
    expect(buildAgentPeerSessionKey({ ...base, dmScope: "per-channel-peer" })).toBe(
      "agent:main:telegram:direct:alice",
    );
    expect(buildAgentPeerSessionKey({ ...base, dmScope: "per-peer" })).toBe("agent:main:direct:alice");
    expect(buildAgentPeerSessionKey({ ...base, dmScope: "main" })).toBe("agent:main:main");
  });

  it("builds group/channel keys", () => {
    expect(
      buildAgentPeerSessionKey({ agentId: "main", channel: "telegram", peerKind: "group", peerId: "-100123" }),
    ).toBe("agent:main:telegram:group:-100123");
    expect(
      buildAgentPeerSessionKey({ agentId: "main", channel: "discord", peerKind: "channel", peerId: "1234" }),
    ).toBe("agent:main:discord:channel:1234");
  });

  it("lowercases by default but preserves case for opaque peers (signal/matrix)", () => {
    expect(normalizeSessionPeerId({ channel: "telegram", peerKind: "direct", peerId: "AlIcE" })).toBe("alice");
    expect(normalizeSessionPeerId({ channel: "signal", peerKind: "group", peerId: "AbCdEf==" })).toBe("AbCdEf==");
    expect(
      normalizeSessionPeerId({ channel: "matrix", peerKind: "channel", peerId: "!RoomID:Matrix.Org" }),
    ).toBe("!RoomID:Matrix.Org");
  });

  it("resolves identity links for non-main DM scopes", () => {
    const key = buildAgentPeerSessionKey({
      agentId: "main",
      channel: "telegram",
      peerKind: "direct",
      peerId: "555",
      dmScope: "per-channel-peer",
      identityLinks: { alice: ["telegram:555"] },
    });
    expect(key).toBe("agent:main:telegram:direct:alice");
  });

  it("rejects structurally invalid inputs", () => {
    expect(() => buildAgentPeerSessionKey({ channel: "", peerKind: "direct", peerId: "x" })).toThrow(SessionKeyError);
    expect(() => buildAgentPeerSessionKey({ channel: "tg", peerKind: "group", peerId: "  " })).toThrow(
      SessionKeyError,
    );
    expect(() => buildAgentMainSessionKey({ agentId: "a:b" })).toThrow(SessionKeyError);
  });

  it("appends and parses thread suffixes", () => {
    const key = appendThreadSuffix("agent:main:telegram:direct:alice", "Thread-9");
    expect(key).toBe("agent:main:telegram:direct:alice:thread:thread-9");
    expect(parseThreadSessionSuffix(key)).toEqual({
      baseSessionKey: "agent:main:telegram:direct:alice",
      threadId: "thread-9",
    });
    expect(parseThreadSessionSuffix("agent:main:main")).toEqual({ baseSessionKey: "agent:main:main" });
  });

  it("parses agent session keys", () => {
    expect(parseAgentSessionKey("agent:main:telegram:direct:alice")).toEqual({
      agentId: "main",
      rest: "telegram:direct:alice",
    });
    expect(parseAgentSessionKey("agent:main")).toBeNull();
    expect(parseAgentSessionKey("nope:main:main")).toBeNull();
    expect(parseAgentSessionKey("")).toBeNull();
  });

  it("classifies acp/cron keys", () => {
    expect(isAcpSessionKey("acp:session-1")).toBe(true);
    expect(isAcpSessionKey("agent:main:acp:x")).toBe(true);
    expect(isAcpSessionKey("agent:main:main")).toBe(false);
    expect(isCronSessionKey("agent:main:cron:job:run:1")).toBe(true);
  });

  it("reverse-parses delivery routes for all shapes", () => {
    expect(parseSessionDeliveryRoute("agent:main:telegram:biz:direct:alice")).toEqual({
      channel: "telegram",
      accountId: "biz",
      peerKind: "direct",
      peerId: "alice",
    });
    expect(parseSessionDeliveryRoute("agent:main:telegram:direct:alice")).toEqual({
      channel: "telegram",
      peerKind: "direct",
      peerId: "alice",
    });
    expect(parseSessionDeliveryRoute("agent:main:direct:alice")).toEqual({
      channel: "",
      peerKind: "direct",
      peerId: "alice",
    });
    expect(parseSessionDeliveryRoute("agent:main:telegram:group:-100:thread:t9")).toEqual({
      channel: "telegram",
      peerKind: "group",
      peerId: "-100",
      threadId: "t9",
    });
    expect(parseSessionDeliveryRoute("agent:main:main")).toBeNull();
    expect(parseSessionDeliveryRoute("garbage")).toBeNull();
  });

  it("round-trips build → parse", () => {
    const key = buildAgentPeerSessionKey({
      agentId: "main",
      channel: "slack",
      accountId: "team1",
      peerKind: "direct",
      peerId: "u123",
      dmScope: "per-account-channel-peer",
    });
    const withThread = appendThreadSuffix(key, "t-1");
    const route = parseSessionDeliveryRoute(withThread);
    expect(route).toEqual({
      channel: "slack",
      accountId: "team1",
      peerKind: "direct",
      peerId: "u123",
      threadId: "t-1",
    });
    const parsed = parseAgentSessionKey(key);
    expect(parsed?.agentId).toBe("main");
  });
});

describe("SessionKeyMap (OmniHarness mapping)", () => {
  it("round-trips key ↔ (profileId, sessionId)", () => {
    const map = new SessionKeyMap();
    const mapping = {
      sessionKey: "agent:main:telegram:default:direct:alice",
      sessionId: "sess-1" as SessionId,
      profileId: "prof-1" as ProfileId,
    };
    map.register(mapping);
    expect(map.get(mapping.sessionKey)).toEqual(mapping);
    expect(map.getBySessionId("sess-1" as SessionId)).toEqual(mapping);
    expect(map.size).toBe(1);
    expect(map.remove(mapping.sessionKey)).toBe(true);
    expect(map.get(mapping.sessionKey)).toBeUndefined();
    expect(map.getBySessionId("sess-1" as SessionId)).toBeUndefined();
  });
});
