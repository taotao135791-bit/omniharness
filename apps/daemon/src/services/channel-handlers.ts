import type { DaemonContext } from "../context.js";
import { RpcError } from "../rpc-server.js";
import { ErrorCodes } from "@omniharness/agent-protocol";
import { nanoid } from "./id.js";
import { nowIso } from "@omniharness/shared-types";

type Register = (name: string, handler: (params: never) => unknown) => void;

/**
 * Channel (OpenClaw adapter) introspection. The adapter itself runs as a
 * component configured here; pairing state and identities live in the DB.
 */
export function registerChannelHandlers(register: Register, ctx: DaemonContext): void {
  const { db } = ctx;

  register("channel.list", () => ({
    channels: db.channels.list().map((c) => ({
      id: c.id,
      kind: c.kind,
      connected: false,
      allowlistedIdentities: [] as string[],
    })),
  }));

  register("channel.pair", (params: { channelKind: string; pairingCode?: string }) => {
    const supported = ["webhook", "telegram", "slack", "discord", "whatsapp"];
    if (!supported.includes(params.channelKind)) {
      throw new RpcError(
        ErrorCodes.INVALID_PARAMS,
        `unsupported channel kind: ${params.channelKind} (supported: ${supported.join(", ")})`,
      );
    }
    const id = nanoid("chan");
    db.channels.put({
      id: id as never,
      kind: params.channelKind,
      displayName: params.channelKind,
      enabled: true,
      config: {},
      createdAt: nowIso(),
    });
    return {
      ok: true,
      instructions:
        `Channel ${id} created. Configure the OpenClaw adapter with this channel's credentials ` +
        `(stored via secret-store refs), then inbound messages will route through it. ` +
        `See docs/research/OPENCLAW_AUDIT.md for the gateway pairing flow.`,
    };
  });

  register("node.list", () => ({
    nodes: db.nodes.list().map((n) => ({
      id: n.id,
      name: n.name,
      platform: n.address,
      connected: n.status === "online",
      capabilities: n.capabilities,
    })),
  }));
}
