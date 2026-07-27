/**
 * Minimal fake OmniHarness daemon for tests: a dependency-free RFC6455
 * (WebSocket) server speaking the @omniharness/agent-protocol envelope.
 * NOT shipped in dist (excluded from tsconfig.build.json).
 */

import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { Socket } from "node:net";
import { PROTOCOL_VERSION } from "@omniharness/agent-protocol";
import type { DomainEvent } from "@omniharness/agent-protocol";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export type CommandHandler = (
  name: string,
  params: Record<string, unknown>,
) => unknown | Promise<unknown>;

/** Any domain event without seq/at (assigned by the fake). */
export type EventInput = {
  [T in DomainEvent["type"]]: Omit<Extract<DomainEvent, { type: T }>, "seq" | "at">;
}[DomainEvent["type"]];

export class FakeDaemon {
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();
  private seq = 0;
  private sessionCounter = 0;
  private runCounter = 0;
  readonly received: Array<{ name: string; params: Record<string, unknown> }> = [];

  constructor(private readonly handler?: CommandHandler) {}

  async start(): Promise<number> {
    this.server = createServer((_req, res) => {
      res.writeHead(426).end();
    });
    this.server.on("upgrade", (req, socket: Socket) => {
      const key = req.headers["sec-websocket-key"];
      if (typeof key !== "string") {
        socket.destroy();
        return;
      }
      const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      this.sockets.add(socket);
      let buffer = Buffer.alloc(0);
      socket.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        for (;;) {
          const frame = this.decodeFrame(buffer);
          if (!frame) break;
          buffer = buffer.subarray(frame.consumed);
          if (frame.opcode === 8) {
            socket.end();
            return;
          }
          if (frame.opcode === 9) {
            socket.write(this.encodeFrame(10, frame.payload));
            continue;
          }
          if (frame.opcode !== 1) continue;
          void this.onText(socket, frame.payload.toString("utf8"));
        }
      });
      socket.on("close", () => this.sockets.delete(socket));
      socket.on("error", () => this.sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      const server = this.server;
      if (!server) return reject(new Error("no server"));
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = this.server.address();
    if (typeof addr !== "object" || addr === null) throw new Error("no address");
    return addr.port;
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  calls(name: string): Array<Record<string, unknown>> {
    return this.received.filter((r) => r.name === name).map((r) => r.params);
  }

  /** Broadcast a domain event to all connected clients (seq/at assigned). */
  emit(event: EventInput): void {
    this.seq += 1;
    const full = { ...event, seq: this.seq, at: new Date().toISOString() };
    this.broadcast(JSON.stringify({ type: "event", event: full }));
  }

  private broadcast(text: string): void {
    const frame = this.encodeFrame(1, Buffer.from(text, "utf8"));
    for (const socket of this.sockets) socket.write(frame);
  }

  private send(socket: Socket, obj: unknown): void {
    socket.write(this.encodeFrame(1, Buffer.from(JSON.stringify(obj), "utf8")));
  }

  private async onText(socket: Socket, text: string): Promise<void> {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }
    if (msg["type"] === "hello") {
      this.send(socket, {
        type: "welcome",
        protocolVersion: PROTOCOL_VERSION,
        daemonVersion: "fake-0.1.0",
        latestSeq: this.seq,
        replayed: false,
      });
      return;
    }
    if (msg["type"] === "command") {
      const id = msg["id"];
      const name = String(msg["name"]);
      const params = (msg["params"] ?? {}) as Record<string, unknown>;
      this.received.push({ name, params });
      try {
        const custom = this.handler ? await this.handler(name, params) : undefined;
        const result = custom !== undefined ? custom : await this.defaultCommand(name, params);
        this.send(socket, { type: "response", id, ok: true, result });
      } catch (e) {
        this.send(socket, {
          type: "response",
          id,
          ok: false,
          error: { code: "internal", message: e instanceof Error ? e.message : String(e) },
        });
      }
    }
  }

  private defaultCommand(name: string, params: Record<string, unknown>): unknown {
    switch (name) {
      case "session.create": {
        this.sessionCounter += 1;
        const now = new Date().toISOString();
        return {
          session: {
            id: `sess-${this.sessionCounter}`,
            profileId: params["profileId"] ?? "prof-1",
            projectId: "proj-1",
            workspaceId: params["workspaceId"] ?? "ws-1",
            title: params["title"] ?? "session",
            tags: [],
            status: "active",
            headMessageId: null,
            createdAt: now,
            updatedAt: now,
            totalUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          },
        };
      }
      case "run.start": {
        this.runCounter += 1;
        return { runId: `run-${this.runCounter}` };
      }
      case "run.interrupt":
      case "run.steer":
        return { ok: true };
      case "approval.resolve":
        return {
          approval: {
            id: params["approvalId"],
            toolCallId: "tc-unknown",
            capability: "shell.exec",
            risk: "medium",
            summary: "resolved by fake",
            detail: {},
            status: params["decision"] === "approve" ? "approved" : "denied",
            createdAt: new Date().toISOString(),
            resolvedAt: new Date().toISOString(),
            resolvedBy: "user",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        };
      default:
        return { ok: true, echo: randomUUID() };
    }
  }

  // ── RFC6455 framing ───────────────────────────────────────────────────────

  private encodeFrame(opcode: number, payload: Buffer): Buffer {
    const len = payload.length;
    let header: Buffer;
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    return Buffer.concat([header, payload]);
  }

  private decodeFrame(buffer: Buffer): { opcode: number; payload: Buffer; consumed: number } | null {
    if (buffer.length < 2) return null;
    const b0 = buffer[0] ?? 0;
    const b1 = buffer[1] ?? 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buffer.length < offset + 2) return null;
      len = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (buffer.length < offset + 8) return null;
      len = Number(buffer.readBigUInt64BE(offset));
      offset += 8;
    }
    let mask: Buffer | null = null;
    if (masked) {
      if (buffer.length < offset + 4) return null;
      mask = buffer.subarray(offset, offset + 4);
      offset += 4;
    }
    if (buffer.length < offset + len) return null;
    const payload = Buffer.from(buffer.subarray(offset, offset + len));
    if (mask) {
      for (let i = 0; i < payload.length; i++) {
        payload[i] = (payload[i] ?? 0) ^ (mask[i % 4] ?? 0);
      }
    }
    return { opcode, payload, consumed: offset + len };
  }
}
