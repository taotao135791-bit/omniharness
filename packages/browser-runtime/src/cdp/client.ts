import { WebSocketConnection } from "./websocket.js";

/** Minimal Chrome DevTools Protocol client over our WebSocket connection. */

export interface CdpError {
  code: number;
  message: string;
}

interface PendingCommand {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

export type CdpEventHandler = (params: unknown, sessionId: string | undefined) => void;

export class CdpProtocolError extends Error {
  readonly code: number;

  constructor(method: string, error: CdpError) {
    super(`CDP ${method} failed: ${error.message} (code ${error.code})`);
    this.name = "CdpProtocolError";
    this.code = error.code;
  }
}

export class CdpClient {
  private readonly ws: WebSocketConnection;
  private readonly commandTimeoutMs: number;
  private nextId = 1;
  private readonly pending = new Map<number, PendingCommand>();
  private readonly handlers = new Map<string, Set<CdpEventHandler>>();
  private closed = false;

  private constructor(ws: WebSocketConnection, commandTimeoutMs: number) {
    this.ws = ws;
    this.commandTimeoutMs = commandTimeoutMs;
    ws.onMessage = (text) => {
      this.handleMessage(text);
    };
    ws.onClose = (info) => {
      this.terminate(new Error(`CDP websocket closed (${info.code ?? "no code"}): ${info.reason}`));
    };
  }

  static async connect(url: string, options: { timeoutMs?: number } = {}): Promise<CdpClient> {
    const ws = await WebSocketConnection.connect({ url, timeoutMs: options.timeoutMs ?? 10_000 });
    return new CdpClient(ws, options.timeoutMs ?? 30_000);
  }

  /** Wraps an existing connection (used by tests with fake transports). */
  static fromConnection(ws: WebSocketConnection, options: { timeoutMs?: number } = {}): CdpClient {
    return new CdpClient(ws, options.timeoutMs ?? 30_000);
  }

  get isOpen(): boolean {
    return !this.closed && this.ws.isOpen;
  }

  /** Sends a CDP command, optionally on a flat session. */
  send<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error(`CDP client is closed (cannot send ${method})`));
    }
    const id = this.nextId;
    this.nextId += 1;
    const message: Record<string, unknown> = { id, method };
    if (params !== undefined) {
      message.params = params;
    }
    if (sessionId !== undefined) {
      message.sessionId = sessionId;
    }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command ${method} timed out after ${this.commandTimeoutMs}ms`));
      }, this.commandTimeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
        method,
      });
      this.ws.sendText(JSON.stringify(message));
    });
  }

  /** Subscribes to a CDP event (any session). Returns an unsubscribe function. */
  on(method: string, handler: CdpEventHandler): () => void {
    let set = this.handlers.get(method);
    if (set === undefined) {
      set = new Set();
      this.handlers.set(method, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.terminate(new Error("CDP client closed"));
    await this.ws.close();
  }

  private terminate(error: Error): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const command of this.pending.values()) {
      clearTimeout(command.timer);
      command.reject(error);
    }
    this.pending.clear();
  }

  private handleMessage(text: string): void {
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null) {
        return;
      }
      message = parsed as Record<string, unknown>;
    } catch {
      return; // malformed frame payload — ignore
    }

    const id = message.id;
    if (typeof id === "number") {
      const command = this.pending.get(id);
      if (command === undefined) {
        return;
      }
      this.pending.delete(id);
      clearTimeout(command.timer);
      const error = message.error as CdpError | undefined;
      if (error !== undefined && typeof error.message === "string") {
        command.reject(new CdpProtocolError(command.method, error));
      } else {
        command.resolve(message.result);
      }
      return;
    }

    const method = message.method;
    if (typeof method === "string") {
      const sessionId = typeof message.sessionId === "string" ? message.sessionId : undefined;
      const set = this.handlers.get(method);
      if (set !== undefined) {
        for (const handler of set) {
          handler(message.params, sessionId);
        }
      }
    }
  }
}
