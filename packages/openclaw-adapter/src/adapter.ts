/**
 * OpenClawAdapter — the facade that wires router → ACP runtime → connectors
 * and relays approvals back to channels.
 */

import { noopAudit } from "./audit.js";
import type { AuditSink } from "./audit.js";
import type { DaemonLike } from "./acp.js";
import { ChannelApprovalRelay, OmniAcpRuntime } from "./acp.js";
import type { ChannelTarget } from "./acp.js";
import type { ConnectorRegistry } from "./channels/connector.js";
import type { MsgContextInput } from "./router.js";
import { ChannelRouter } from "./router.js";
import type { InboundMessage, RouterConfig } from "./router.js";
import { SessionKeyMap } from "./session-keys.js";

export interface OpenClawAdapterDeps {
  daemon: DaemonLike;
  routerConfig: RouterConfig;
  connectors: ConnectorRegistry;
  audit?: AuditSink;
  approvalTimeoutMs?: number;
  turnTimeoutMs?: number;
}

export class OpenClawAdapter {
  readonly router: ChannelRouter;
  readonly runtime: OmniAcpRuntime;
  readonly approvals: ChannelApprovalRelay;
  readonly sessionKeys: SessionKeyMap;
  private readonly connectors: ConnectorRegistry;
  private readonly turnTimeoutMs: number | undefined;
  private running = false;

  constructor(private readonly deps: OpenClawAdapterDeps) {
    const audit = deps.audit ?? noopAudit;
    this.sessionKeys = new SessionKeyMap();
    this.router = new ChannelRouter(deps.routerConfig, { audit });
    this.runtime = new OmniAcpRuntime(deps.daemon, { sessionKeys: this.sessionKeys, audit });
    this.approvals = new ChannelApprovalRelay({
      daemon: deps.daemon,
      sessionKeys: this.sessionKeys,
      send: (target, text) => this.sendToTarget(target, text),
      audit,
      ...(deps.approvalTimeoutMs !== undefined ? { timeoutMs: deps.approvalTimeoutMs } : {}),
    });
    this.connectors = deps.connectors;
    this.turnTimeoutMs = deps.turnTimeoutMs;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.approvals.start();
    await this.connectors.startAll((raw) => {
      void this.onInbound(raw).catch(() => {
        // Errors surfacing here are already audited at the decision point;
        // the inbound loop must never throw back into a connector.
      });
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    this.approvals.stop();
    await this.runtime.close();
    await this.connectors.stopAll();
  }

  private async sendToTarget(target: ChannelTarget, text: string): Promise<void> {
    const connector = this.connectors.get(target.channel, target.accountId);
    if (!connector) throw new Error(`no connector for ${target.channel}/${target.accountId}`);
    await connector.send({
      to: target.route.peerId,
      text,
      ...(target.route.threadId ? { threadId: target.route.threadId } : {}),
    });
  }

  private async onInbound(raw: MsgContextInput): Promise<void> {
    const result = this.router.route(raw);
    if (!result.ok) return;
    const message = result.message;

    // A yes/no reply to a pending approval is consumed by the relay, not run
    // as an agent turn.
    if (
      this.approvals.handleChannelReply({
        sessionKey: message.sessionKey,
        senderId: message.senderId,
        body: message.body,
      })
    ) {
      return;
    }

    await this.runInboundTurn(message);
  }

  private async runInboundTurn(message: InboundMessage): Promise<void> {
    await this.runtime.ensureSession(message.sessionKey, {
      route: { profileId: message.route.profileId, workspaceId: message.route.workspaceId },
      title: `${message.channel}:${message.senderId}`,
    });
    let output = "";
    const attachments = message.media
      .filter((m) => typeof m.url === "string" && m.url.length > 0)
      .map((m, i) => ({ uri: m.url as string, mimeType: m.mediaType, name: `attachment-${i}` }));
    const done = await this.runtime.runTurn(message.sessionKey, message.body, {
      attachments,
      ...(this.turnTimeoutMs !== undefined ? { turnTimeoutMs: this.turnTimeoutMs } : {}),
      onEvent: (event) => {
        if (event.type === "text_delta" && (event.stream ?? "output") === "output") {
          output += event.text;
        }
      },
    });
    const target: ChannelTarget = {
      route: message.deliveryRoute,
      channel: message.channel,
      accountId: message.accountId,
    };
    if (done.status === "ok" && output.length > 0) {
      await this.sendToTarget(target, output);
    } else if (done.status === "error") {
      await this.sendToTarget(target, `Sorry, something went wrong: ${done.stopReason ?? "unknown error"}`);
    }
  }
}
