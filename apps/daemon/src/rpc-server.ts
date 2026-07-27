import { WebSocketServer, WebSocket } from "ws";
import type {
  ClientMessage,
  CommandName,
  CommandParams,
  CommandResult,
  HelloMessage,
  ServerMessage,
} from "@omniharness/agent-protocol";
import { ErrorCodes, PROTOCOL_VERSION, isCompatible } from "@omniharness/agent-protocol";
import type { EventBus } from "./event-bus.js";
import type { Logger } from "@omniharness/observability";

/** Handler for one command name. Throwing an RpcError produces a clean error response. */
export type CommandHandler<N extends CommandName = CommandName> = (
  params: CommandParams<N>,
  ctx: CommandContext,
) => Promise<CommandResult<N>> | CommandResult<N>;

export interface CommandContext {
  clientKind: string;
  clientName: string;
}

export class RpcError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retriable = false,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

interface ClientState {
  ws: WebSocket;
  hello: HelloMessage | null;
  unsubscribe: (() => void) | null;
}

/**
 * Loopback WebSocket RPC server. One auth token (per-install, 0600 file),
 * protocol version negotiation, event broadcast with replay on reconnect.
 */
export class RpcServer {
  private wss: WebSocketServer | null = null;
  private handlers = new Map<string, CommandHandler>();
  private clients = new Set<ClientState>();

  constructor(
    private readonly opts: {
      host: string;
      port: number;
      authToken: string;
      daemonVersion: string;
      bus: EventBus;
      log: Logger;
    },
  ) {}

  register<N extends CommandName>(name: N, handler: CommandHandler<N>): void {
    this.handlers.set(name, handler as unknown as CommandHandler);
  }

  /** Actual bound port (differs from opts.port when 0). */
  get port(): number {
    const addr = this.wss?.address();
    return typeof addr === "object" && addr !== null ? addr.port : this.opts.port;
  }

  async start(): Promise<void> {
    const { host, port } = this.opts;
    this.wss = new WebSocketServer({ host, port });
    await new Promise<void>((resolve, reject) => {
      this.wss!.once("listening", resolve);
      this.wss!.once("error", reject);
    });
    this.wss.on("connection", (ws) => this.onConnection(ws));
    this.opts.log.info(`rpc listening on ${host}:${this.port}`);
  }

  private onConnection(ws: WebSocket): void {
    const state: ClientState = { ws, hello: null, unsubscribe: null };
    this.clients.add(state);
    // Auth timeout: unauthenticated sockets don't linger.
    const authTimer = setTimeout(() => {
      if (!state.hello) ws.close(4001, "auth timeout");
    }, 10_000);

    ws.on("message", (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(raw)) as ClientMessage;
      } catch {
        ws.send(
          JSON.stringify(this.errorResponse(null, ErrorCodes.INVALID_PARAMS, "malformed json")),
        );
        return;
      }
      if (msg.type === "hello") {
        clearTimeout(authTimer);
        this.onHello(state, msg);
        return;
      }
      if (!state.hello) {
        ws.send(
          JSON.stringify(this.errorResponse(null, ErrorCodes.UNAUTHORIZED, "hello required")),
        );
        return;
      }
      if (msg.type === "command") {
        void this.onCommand(state, msg);
      }
    });

    ws.on("close", () => {
      clearTimeout(authTimer);
      state.unsubscribe?.();
      this.clients.delete(state);
    });
  }

  private onHello(state: ClientState, hello: HelloMessage): void {
    const { ws } = state;
    if (hello.authToken !== this.opts.authToken) {
      ws.send(
        JSON.stringify({
          type: "response",
          id: null,
          ok: false,
          error: { code: ErrorCodes.UNAUTHORIZED, message: "bad token" },
        }),
      );
      ws.close(4003, "unauthorized");
      return;
    }
    if (!isCompatible(hello.protocolVersion)) {
      ws.send(
        JSON.stringify({
          type: "response",
          id: null,
          ok: false,
          error: {
            code: ErrorCodes.CONFLICT,
            message: `protocol ${PROTOCOL_VERSION.major}.${PROTOCOL_VERSION.minor} required`,
          },
        }),
      );
      ws.close(4002, "protocol mismatch");
      return;
    }
    state.hello = hello;

    // Replay missed events, then go live.
    let replayed = false;
    const lastSeen = hello.lastEventSeq ?? 0;
    if (lastSeen > 0 && lastSeen < this.opts.bus.latestSeq()) {
      const { events } = this.opts.bus.since(lastSeen, 10_000);
      for (const event of events) this.send(ws, { type: "event", event });
      replayed = true;
    }
    state.unsubscribe = this.opts.bus.subscribe((event) => {
      this.send(ws, { type: "event", event });
    });
    this.send(ws, {
      type: "welcome",
      protocolVersion: PROTOCOL_VERSION,
      daemonVersion: this.opts.daemonVersion,
      latestSeq: this.opts.bus.latestSeq(),
      replayed,
    });
    this.opts.log.info("client connected", { kind: hello.client.kind, name: hello.client.name });
  }

  private async onCommand(
    state: ClientState,
    msg: { id: string; name: string; params: unknown },
  ): Promise<void> {
    const handler = this.handlers.get(msg.name);
    if (!handler) {
      this.send(
        state.ws,
        this.errorResponse(msg.id, ErrorCodes.NOT_FOUND, `unknown command: ${msg.name}`),
      );
      return;
    }
    const ctx: CommandContext = {
      clientKind: state.hello?.client.kind ?? "unknown",
      clientName: state.hello?.client.name ?? "unknown",
    };
    try {
      const result = await handler(msg.params as never, ctx);
      this.send(state.ws, { type: "response", id: msg.id, ok: true, result });
    } catch (err) {
      if (err instanceof RpcError) {
        this.send(state.ws, this.errorResponse(msg.id, err.code, err.message, err.retriable));
      } else {
        this.opts.log.error("command failed", {
          name: msg.name,
          error: err instanceof Error ? err.message : String(err),
        });
        this.send(
          state.ws,
          this.errorResponse(
            msg.id,
            ErrorCodes.INTERNAL,
            err instanceof Error ? err.message : "internal error",
          ),
        );
      }
    }
  }

  private errorResponse(
    id: string | null,
    code: string,
    message: string,
    retriable = false,
  ): ServerMessage {
    return { type: "response", id: id ?? "", ok: false, error: { code, message, retriable } };
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  broadcastShutdown(reason: string): void {
    this.opts.bus.emit({ type: "daemon.shutdown", reason });
  }

  async stop(): Promise<void> {
    for (const c of this.clients) {
      c.unsubscribe?.();
      c.ws.close(1001, "daemon stopping");
    }
    this.clients.clear();
    await new Promise<void>((resolve) => this.wss?.close(() => resolve()));
    this.wss = null;
  }
}
