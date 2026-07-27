import { createRequire } from "node:module";
import { PROTOCOL_VERSION, type DomainEvent } from "@omniharness/agent-protocol";

/**
 * FakeDaemon: a real WebSocket server speaking the OmniHarness wire protocol,
 * backed by the `ws` dependency of @omniharness/client-sdk (resolved through
 * that package so apps/tui needs no new dependency). Scriptable per-command
 * handlers; events are broadcast with monotonic seq like the real daemon.
 */

interface WsSocket {
  send(data: string): void;
  on(event: "message", cb: (data: unknown) => void): void;
  close(): void;
}

interface WsServer {
  on(event: "connection", cb: (ws: WsSocket) => void): void;
  once(event: "listening", cb: () => void): void;
  address(): { port: number } | string | null;
  close(cb?: () => void): void;
}

const require = createRequire(
  new URL("../../../../packages/client-sdk/package.json", import.meta.url),
);
const { WebSocketServer } = require("ws") as {
  WebSocketServer: new (opts: { host: string; port: number }) => WsServer;
};

export type CommandHandler = (params: Record<string, unknown>) => unknown;

/** Omit that distributes over a union (plain Omit collapses union members). */
type DistributiveOmit<T, K extends keyof never | string> = T extends unknown ? Omit<T, K> : never;

/** A domain event without seq/at (the FakeDaemon assigns those). */
export type EventInput = DistributiveOmit<DomainEvent, "seq" | "at">;

export interface ReceivedCommand {
  name: string;
  params: Record<string, unknown>;
}

export class FakeDaemon {
  readonly received: ReceivedCommand[] = [];
  private readonly handlers = new Map<string, CommandHandler>();
  private readonly sockets = new Set<WsSocket>();
  private seq = 0;

  private constructor(
    private readonly wss: WsServer,
    readonly url: string,
  ) {}

  static async start(): Promise<FakeDaemon> {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => wss.once("listening", resolve));
    const address = wss.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const daemon = new FakeDaemon(wss, `ws://127.0.0.1:${port}`);
    wss.on("connection", (ws) => daemon.onConnection(ws));
    return daemon;
  }

  /** Register a handler for a command name, e.g. on("session.list", ...) */
  on(name: string, handler: CommandHandler): this {
    this.handlers.set(name, handler);
    return this;
  }

  /** Broadcast a domain event (seq/at are filled in). */
  emit(event: EventInput): void {
    this.seq += 1;
    const full = { ...event, seq: this.seq, at: new Date().toISOString() };
    const frame = JSON.stringify({ type: "event", event: full });
    for (const ws of this.sockets) ws.send(frame);
  }

  commandsNamed(name: string): ReceivedCommand[] {
    return this.received.filter((c) => c.name === name);
  }

  lastCommand(name: string): ReceivedCommand | undefined {
    const list = this.commandsNamed(name);
    return list[list.length - 1];
  }

  close(): Promise<void> {
    for (const ws of this.sockets) ws.close();
    return new Promise((resolve) => this.wss.close(() => resolve()));
  }

  private onConnection(ws: WsSocket): void {
    this.sockets.add(ws);
    ws.on("message", (raw) => {
      let msg: { type?: string; id?: string; name?: string; params?: Record<string, unknown> };
      try {
        msg = JSON.parse(String(raw)) as typeof msg;
      } catch {
        return;
      }
      if (msg.type === "hello") {
        ws.send(
          JSON.stringify({
            type: "welcome",
            protocolVersion: PROTOCOL_VERSION,
            daemonVersion: "0.0.0-fake",
            latestSeq: this.seq,
            replayed: false,
          }),
        );
        return;
      }
      if (msg.type === "command" && msg.id && msg.name) {
        const params = msg.params ?? {};
        this.received.push({ name: msg.name, params });
        const handler = this.handlers.get(msg.name);
        if (!handler) {
          ws.send(
            JSON.stringify({
              type: "response",
              id: msg.id,
              ok: false,
              error: { code: "invalid_params", message: `no handler for ${msg.name}` },
            }),
          );
          return;
        }
        try {
          const result = handler(params) as { __error?: { code: string; message: string } };
          if (result && typeof result === "object" && result.__error) {
            ws.send(
              JSON.stringify({ type: "response", id: msg.id, ok: false, error: result.__error }),
            );
            return;
          }
          ws.send(JSON.stringify({ type: "response", id: msg.id, ok: true, result }));
        } catch (err) {
          ws.send(
            JSON.stringify({
              type: "response",
              id: msg.id,
              ok: false,
              error: {
                code: "internal",
                message: err instanceof Error ? err.message : String(err),
              },
            }),
          );
        }
      }
    });
  }
}

/** Helper: respond with a daemon error from a handler. */
export function daemonError(
  code: string,
  message: string,
): { __error: { code: string; message: string } } {
  return { __error: { code, message } };
}
