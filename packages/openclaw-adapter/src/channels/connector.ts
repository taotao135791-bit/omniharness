/**
 * Channel connector contract.
 *
 * The adapter does NOT reimplement each chat network (grammy/bolt/baileys…).
 * OpenClaw's own channel plugins stay attached to its gateway; connectors here
 * are thin seams: inbound messages arrive normalized (MsgContext-shaped), and
 * outbound text goes back through a per-kind formatter to the channel's
 * delivery endpoint (gateway hook or direct webhook).
 */

import type { MsgContextInput } from "../router.js";

export interface OutboundMessage {
  /** Channel peer address (chat id / channel id / user id). */
  to: string;
  text: string;
  threadId?: string;
  replyToId?: string;
}

export type InboundHandler = (raw: MsgContextInput) => void;

export interface ChannelConnector {
  /** Channel kind this connector serves, e.g. "telegram". */
  readonly kind: string;
  /** Account this connector serves (multi-account channels). */
  readonly accountId: string;
  start(handler: InboundHandler): Promise<void>;
  send(message: OutboundMessage): Promise<void>;
  stop(): Promise<void>;
}

/** Registry used by the adapter runtime to fan messages out to connectors. */
export class ConnectorRegistry {
  private readonly connectors = new Map<string, ChannelConnector>();

  private static keyOf(kind: string, accountId: string): string {
    return `${kind.toLowerCase()}:${accountId.toLowerCase()}`;
  }

  add(connector: ChannelConnector): void {
    this.connectors.set(ConnectorRegistry.keyOf(connector.kind, connector.accountId), connector);
  }

  get(kind: string, accountId: string): ChannelConnector | undefined {
    return this.connectors.get(ConnectorRegistry.keyOf(kind, accountId));
  }

  list(): ChannelConnector[] {
    return [...this.connectors.values()];
  }

  async startAll(handler: InboundHandler): Promise<void> {
    for (const c of this.connectors.values()) await c.start(handler);
  }

  async stopAll(): Promise<void> {
    for (const c of this.connectors.values()) await c.stop();
  }
}
