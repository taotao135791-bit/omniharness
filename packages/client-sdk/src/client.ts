import WebSocket from "ws";
import type {
  CommandMessage,
  CommandName,
  CommandParams,
  CommandResult,
  DomainEvent,
  ResponseMessage,
  ServerMessage,
  WelcomeMessage,
} from "@omniharness/agent-protocol";
import { ErrorCodes, PROTOCOL_VERSION, isCompatible } from "@omniharness/agent-protocol";

export interface ClientOptions {
  /** ws:// URL of the daemon, e.g. ws://127.0.0.1:7777 */
  url: string;
  authToken: string;
  client: { kind: "tui" | "gui" | "cli" | "sdk" | "channel"; name: string; version: string };
  /** Resume from this event seq after reconnect. */
  lastEventSeq?: number;
  /** Reconnect with backoff. Default true. */
  autoReconnect?: boolean;
  maxReconnectDelayMs?: number;
}

export type EventHandler = (event: DomainEvent) => void;
export type ConnectionHandler = (state: "connected" | "disconnected" | "replaying") => void;

export class OmniClientError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retriable: boolean = false,
  ) {
    super(message);
    this.name = "OmniClientError";
  }
}

/**
 * Typed client for the OmniHarness daemon. One instance = one connection.
 * TUI, GUI, CLI and channel adapters all use this; nothing else speaks the wire.
 */
export class OmniClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private eventHandlers = new Set<EventHandler>();
  private connectionHandlers = new Set<ConnectionHandler>();
  private lastSeq: number;
  private reconnectAttempts = 0;
  private closed = false;
  private welcome: WelcomeMessage | null = null;

  constructor(private readonly options: ClientOptions) {
    this.lastSeq = options.lastEventSeq ?? 0;
  }

  get latestSeq(): number {
    return this.lastSeq;
  }

  get daemonVersion(): string | null {
    return this.welcome?.daemonVersion ?? null;
  }

  onEvent(handler: EventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  onConnectionChange(handler: ConnectionHandler): () => void {
    this.connectionHandlers.add(handler);
    return () => this.connectionHandlers.delete(handler);
  }

  private emitConnection(state: "connected" | "disconnected" | "replaying"): void {
    for (const h of this.connectionHandlers) h(state);
  }

  async connect(): Promise<void> {
    this.closed = false;
    await this.openSocket();
  }

  private openSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.options.url, { handshakeTimeout: 10_000 });
      this.ws = ws;
      const onOpen = (): void => {
        const hello = {
          type: "hello",
          protocolVersion: PROTOCOL_VERSION,
          client: this.options.client,
          authToken: this.options.authToken,
          lastEventSeq: this.lastSeq,
        };
        ws.send(JSON.stringify(hello));
      };
      const onMessage = (data: unknown): void => {
        let msg: ServerMessage;
        try {
          msg = JSON.parse(String(data)) as ServerMessage;
        } catch {
          return; // ignore malformed frames
        }
        if (msg.type === "welcome") {
          if (!isCompatible(msg.protocolVersion)) {
            reject(
              new OmniClientError(
                ErrorCodes.CONFLICT,
                `Incompatible protocol: daemon ${msg.protocolVersion.major}.${msg.protocolVersion.minor}, client ${PROTOCOL_VERSION.major}.${PROTOCOL_VERSION.minor}`,
              ),
            );
            ws.close();
            return;
          }
          this.welcome = msg;
          this.reconnectAttempts = 0;
          this.emitConnection("connected");
          resolve();
          return;
        }
        if (msg.type === "response") {
          this.handleResponse(msg);
          return;
        }
        if (msg.type === "event") {
          if (msg.event.seq > this.lastSeq) this.lastSeq = msg.event.seq;
          for (const h of this.eventHandlers) h(msg.event);
        }
      };
      const onError = (err: Error): void => {
        if (this.welcome === null) reject(new OmniClientError(ErrorCodes.INTERNAL, err.message));
      };
      const onClose = (): void => {
        this.ws = null;
        this.emitConnection("disconnected");
        this.failAllPending(new OmniClientError(ErrorCodes.INTERNAL, "connection closed", true));
        if (!this.closed && (this.options.autoReconnect ?? true)) {
          void this.scheduleReconnect();
        }
      };
      ws.once("open", onOpen);
      ws.on("message", onMessage);
      ws.on("error", onError);
      ws.on("close", onClose);
    });
  }

  private async scheduleReconnect(): Promise<void> {
    const max = this.options.maxReconnectDelayMs ?? 15_000;
    const delay = Math.min(max, 250 * 2 ** this.reconnectAttempts) * (0.5 + Math.random() * 0.5);
    this.reconnectAttempts += 1;
    await new Promise((r) => setTimeout(r, delay));
    if (this.closed) return;
    try {
      await this.openSocket();
    } catch {
      if (!this.closed) void this.scheduleReconnect();
    }
  }

  private handleResponse(msg: ResponseMessage): void {
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    if (msg.ok) entry.resolve(msg.result);
    else
      entry.reject(
        new OmniClientError(
          msg.error?.code ?? ErrorCodes.INTERNAL,
          msg.error?.message ?? "unknown error",
          msg.error?.retriable ?? false,
        ),
      );
  }

  private failAllPending(err: Error): void {
    for (const [, entry] of this.pending) entry.reject(err);
    this.pending.clear();
  }

  /** Call any daemon command, fully typed against the command catalog. */
  async call<N extends CommandName>(name: N, params: CommandParams<N>): Promise<CommandResult<N>> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new OmniClientError(ErrorCodes.INTERNAL, "not connected", true);
    }
    const id = `c${this.nextId++}`;
    const message: CommandMessage<N> = { type: "command", id, name, params };
    const result = await new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      ws.send(JSON.stringify(message));
    });
    return result as CommandResult<N>;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.failAllPending(new OmniClientError(ErrorCodes.INTERNAL, "client closed"));
    this.ws?.close();
    this.ws = null;
  }
}

/** Connect with one call. */
export async function connect(options: ClientOptions): Promise<OmniClient> {
  const client = new OmniClient(options);
  await client.connect();
  return client;
}
