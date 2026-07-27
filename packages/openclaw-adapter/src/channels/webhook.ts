import { createServer } from "node:http";
import type { Server } from "node:http";
import type { ChannelConnector, InboundHandler, OutboundMessage } from "./connector.js";
import type { ChannelFormatter } from "./formatters.js";
import { formatterFor } from "./formatters.js";
import type { MsgContextInput } from "../router.js";

export interface WebhookConnectorOptions {
  accountId?: string;
  /** Bind host. Default 127.0.0.1 (loopback only). */
  host?: string;
  /** Port to listen on; 0 picks a free port. */
  port: number;
  /** Inbound path. Default `/webhook/<kind>`. */
  path?: string;
  /**
   * Shared secret the caller (OpenClaw gateway hook / channel plugin) must
   * present in the `x-hook-token` header. Required — an unauthenticated
   * inbound webhook would let anyone inject messages as any sender.
   */
  secretToken: string;
  /** Where outbound messages are POSTed (gateway hook / channel send endpoint). */
  outboundUrl: string;
  outboundHeaders?: Record<string, string>;
  formatter?: ChannelFormatter;
  /** Max inbound body size. Default 1 MiB. */
  maxBodyBytes?: number;
}

const TIMING_SAFE_PAD = 64;

function safeEqualSecret(a: string, b: string): boolean {
  // Constant-time-ish compare without leaking length early.
  const ba = Buffer.from(a.padEnd(TIMING_SAFE_PAD, " "));
  const bb = Buffer.from(b.padEnd(TIMING_SAFE_PAD, " "));
  if (ba.length !== bb.length) return false;
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < ba.length; i++) diff |= (ba[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

/**
 * Generic inbound HTTP webhook connector. OpenClaw's channel plugins (or its
 * gateway `/hooks/*` surface) POST normalized inbound messages here; outbound
 * replies are POSTed back to the configured delivery endpoint. This is how
 * telegram/slack/discord are wired through OpenClaw's gateway without the
 * adapter reimplementing any of their network protocols.
 */
export class WebhookConnector implements ChannelConnector {
  readonly accountId: string;
  private readonly formatter: ChannelFormatter;
  private server: Server | null = null;
  private handler: InboundHandler | null = null;
  private boundPort = 0;

  constructor(
    readonly kind: string,
    private readonly options: WebhookConnectorOptions,
  ) {
    this.accountId = options.accountId ?? "default";
    this.formatter = options.formatter ?? formatterFor(kind);
  }

  get port(): number {
    return this.boundPort;
  }

  get inboundPath(): string {
    return this.options.path ?? `/webhook/${this.kind.toLowerCase()}`;
  }

  async start(handler: InboundHandler): Promise<void> {
    if (this.server) throw new Error(`WebhookConnector(${this.kind}) already started`);
    this.handler = handler;
    const maxBody = this.options.maxBodyBytes ?? 1024 * 1024;
    this.server = createServer((req, res) => {
      void (async () => {
        try {
          if (req.method !== "POST" || req.url !== this.inboundPath) {
            res
              .writeHead(404, { "content-type": "application/json" })
              .end(JSON.stringify({ ok: false, error: "not found" }));
            return;
          }
          const token = req.headers["x-hook-token"];
          if (typeof token !== "string" || !safeEqualSecret(token, this.options.secretToken)) {
            res
              .writeHead(401, { "content-type": "application/json" })
              .end(JSON.stringify({ ok: false, error: "unauthorized" }));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of req) {
            const buf = chunk as Buffer;
            size += buf.length;
            if (size > maxBody) {
              res
                .writeHead(413, { "content-type": "application/json" })
                .end(JSON.stringify({ ok: false, error: "body too large" }));
              return;
            }
            chunks.push(buf);
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            res
              .writeHead(400, { "content-type": "application/json" })
              .end(JSON.stringify({ ok: false, error: "invalid json" }));
            return;
          }
          const normalized = this.formatter.parseInbound(parsed);
          if (!normalized) {
            res
              .writeHead(422, { "content-type": "application/json" })
              .end(JSON.stringify({ ok: false, error: "unrecognized payload" }));
            return;
          }
          const raw: MsgContextInput = {
            Provider: this.kind,
            AccountId: this.accountId,
            From: normalized.from,
            ChatType: normalized.chatType,
            SenderId: normalized.senderId,
            Body: normalized.body,
          };
          if (normalized.senderName) raw.SenderName = normalized.senderName;
          if (normalized.senderUsername) raw.SenderUsername = normalized.senderUsername;
          if (normalized.threadId) raw.MessageThreadId = normalized.threadId;
          if (normalized.media) raw.media = normalized.media;
          this.handler?.(raw);
          res
            .writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify({ ok: true }));
        } catch (e) {
          res
            .writeHead(500, { "content-type": "application/json" })
            .end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }));
        }
      })();
    });
    await new Promise<void>((resolve, reject) => {
      const server = this.server;
      if (!server) return reject(new Error("server not created"));
      server.once("error", reject);
      server.listen(this.options.port, this.options.host ?? "127.0.0.1", () => {
        const addr = server.address();
        this.boundPort = typeof addr === "object" && addr !== null ? addr.port : this.options.port;
        resolve();
      });
    });
  }

  async send(message: OutboundMessage): Promise<void> {
    if (!this.server) throw new Error(`WebhookConnector(${this.kind}) not started`);
    const body = this.formatter.formatOutbound(message);
    const res = await fetch(this.options.outboundUrl, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.options.outboundHeaders ?? {}) },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`outbound delivery failed: HTTP ${res.status}`);
    }
  }

  async stop(): Promise<void> {
    this.handler = null;
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
}
