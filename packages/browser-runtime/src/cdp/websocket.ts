import { createHash, randomBytes } from "node:crypto";
import { connect as netConnect, type Socket } from "node:net";

/**
 * Minimal RFC 6455 WebSocket client over node:net — just enough for Chrome
 * DevTools Protocol: client-masked text/binary frames, fragmentation,
 * ping/pong, close handshake. No extensions, no compression, ws:// only
 * (CDP listens on loopback plain sockets; wss:// is out of scope).
 *
 * The frame codec (encodeFrame / WsFrameParser) is pure and used by both the
 * client and by tests that stand up fake CDP servers.
 */

export const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export const OPCODES = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
} as const;

export type WsOpcode = (typeof OPCODES)[keyof typeof OPCODES];

export interface WsFrame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
}

/** Largest frame payload accepted, guarding against hostile length headers. */
export const MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;

export function computeAcceptKey(secWebSocketKey: string): string {
  return createHash("sha1")
    .update(secWebSocketKey + WS_GUID)
    .digest("base64");
}

/** Serializes one frame. Clients MUST mask; servers MUST NOT. */
export function encodeFrame(frame: WsFrame, options: { mask: boolean }): Buffer {
  const payload = frame.payload;
  const length = payload.length;
  if (length > MAX_PAYLOAD_BYTES) {
    throw new RangeError(`frame payload too large: ${length} bytes`);
  }

  let header: Buffer;
  if (length < 126) {
    header = Buffer.allocUnsafe(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.allocUnsafe(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = (frame.fin ? 0x80 : 0x00) | (frame.opcode & 0x0f);
  if (options.mask) {
    header[1] = (header[1] ?? 0) | 0x80;
  }

  if (!options.mask) {
    return Buffer.concat([header, payload]);
  }
  const maskKey = randomBytes(4);
  const masked = Buffer.allocUnsafe(length);
  for (let i = 0; i < length; i += 1) {
    masked[i] = payload.readUInt8(i) ^ maskKey.readUInt8(i & 3);
  }
  return Buffer.concat([header, maskKey, masked]);
}

/**
 * Incremental frame decoder. Feed arbitrary TCP chunks with push(); complete
 * frames come back. Masked and unmasked frames are both accepted (servers
 * send unmasked; fake servers in tests use it to decode client frames).
 */
export class WsFrameParser {
  private buffer: Buffer = Buffer.alloc(0);

  push(data: Buffer): WsFrame[] {
    this.buffer = this.buffer.length === 0 ? data : Buffer.concat([this.buffer, data]);
    const frames: WsFrame[] = [];
    for (;;) {
      const frame = this.tryParseFrame();
      if (frame === null) {
        break;
      }
      frames.push(frame);
    }
    return frames;
  }

  get bufferedBytes(): number {
    return this.buffer.length;
  }

  private tryParseFrame(): WsFrame | null {
    const buf = this.buffer;
    if (buf.length < 2) {
      return null;
    }
    const b0 = buf.readUInt8(0);
    const b1 = buf.readUInt8(1);
    if ((b0 & 0x70) !== 0) {
      throw new Error("websocket RSV bits set but no extensions were negotiated");
    }
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let length = b1 & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buf.length < 4) {
        return null;
      }
      length = buf.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buf.length < 10) {
        return null;
      }
      const big = buf.readBigUInt64BE(2);
      if (big > BigInt(MAX_PAYLOAD_BYTES)) {
        throw new Error(`websocket frame exceeds max payload: ${big}`);
      }
      length = Number(big);
      offset = 10;
    }
    if (length > MAX_PAYLOAD_BYTES) {
      throw new Error(`websocket frame exceeds max payload: ${length}`);
    }
    const maskLength = masked ? 4 : 0;
    if (buf.length < offset + maskLength + length) {
      return null;
    }
    let payload: Buffer = buf.subarray(offset + maskLength, offset + maskLength + length);
    if (masked) {
      const key = buf.subarray(offset, offset + 4);
      const unmasked = Buffer.allocUnsafe(length);
      for (let i = 0; i < length; i += 1) {
        unmasked[i] = payload.readUInt8(i) ^ key.readUInt8(i & 3);
      }
      payload = unmasked;
    }
    this.buffer = buf.subarray(offset + maskLength + length);
    return { fin, opcode, payload };
  }
}

export interface WebSocketConnectOptions {
  url: string;
  timeoutMs?: number;
}

export interface WsCloseInfo {
  code: number | null;
  reason: string;
}

export class WebSocketConnection {
  private readonly socket: Socket;
  private readonly parser = new WsFrameParser();
  private fragments: Buffer[] = [];
  private fragmentOpcode: number | null = null;
  private closeSent = false;
  private closed = false;

  onMessage: ((text: string) => void) | null = null;
  onBinary: ((data: Buffer) => void) | null = null;
  onClose: ((info: WsCloseInfo) => void) | null = null;
  onError: ((error: Error) => void) | null = null;

  private constructor(socket: Socket) {
    this.socket = socket;
  }

  /** Attaches the data/error/close handlers once the handshake has completed. */
  private attach(): void {
    this.socket.on("data", (chunk: Buffer) => {
      try {
        this.handleData(chunk);
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    this.socket.on("error", (error: Error) => {
      this.onError?.(error);
    });
    this.socket.on("close", () => {
      this.finishClose({ code: null, reason: "socket closed" });
    });
  }

  /** Performs the HTTP upgrade handshake and returns an open connection. */
  static connect(options: WebSocketConnectOptions): Promise<WebSocketConnection> {
    const url = new URL(options.url);
    if (url.protocol !== "ws:") {
      return Promise.reject(
        new Error(
          `only ws:// URLs are supported (CDP is loopback plain HTTP), got ${url.protocol}`,
        ),
      );
    }
    const host = url.hostname;
    const port = url.port === "" ? 80 : Number.parseInt(url.port, 10);
    const path = `${url.pathname}${url.search}`;
    const timeoutMs = options.timeoutMs ?? 10_000;

    return new Promise((resolve, reject) => {
      const key = randomBytes(16).toString("base64");
      const socket = netConnect({ host, port });
      const connection = new WebSocketConnection(socket);
      let settled = false;
      let head: Buffer = Buffer.alloc(0);

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          socket.destroy();
          reject(new Error(`websocket handshake timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      const onHandshakeData = (chunk: Buffer): void => {
        head = head.length === 0 ? chunk : Buffer.concat([head, chunk]);
        const end = head.indexOf("\r\n\r\n");
        if (end === -1) {
          if (head.length > 16_384) {
            settled = true;
            clearTimeout(timer);
            socket.destroy();
            reject(new Error("websocket handshake response too large"));
          }
          return;
        }
        const response = head.subarray(0, end).toString("latin1");
        const rest = head.subarray(end + 4);
        socket.off("data", onHandshakeData);
        clearTimeout(timer);
        try {
          validateHandshakeResponse(response, key);
        } catch (error) {
          settled = true;
          socket.destroy();
          reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        settled = true;
        socket.off("error", onHandshakeError);
        connection.attach();
        resolve(connection);
        if (rest.length > 0) {
          connection.handleData(rest);
        }
      };

      const onHandshakeError = (error: Error): void => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
      };

      socket.once("error", onHandshakeError);
      socket.on("data", onHandshakeData);
      socket.write(
        `GET ${path} HTTP/1.1\r\n` +
          `Host: ${host}:${port}\r\n` +
          `Upgrade: websocket\r\n` +
          `Connection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\n` +
          `Sec-WebSocket-Version: 13\r\n` +
          `\r\n`,
      );
    });
  }

  get isOpen(): boolean {
    return !this.closed && !this.closeSent;
  }

  sendText(text: string): void {
    this.writeFrame({ fin: true, opcode: OPCODES.TEXT, payload: Buffer.from(text, "utf8") });
  }

  sendBinary(data: Buffer): void {
    this.writeFrame({ fin: true, opcode: OPCODES.BINARY, payload: data });
  }

  ping(payload: Buffer = Buffer.alloc(0)): void {
    this.writeFrame({ fin: true, opcode: OPCODES.PING, payload });
  }

  /** Sends a close frame and waits for the socket to finish closing. */
  async close(code = 1000, reason = ""): Promise<void> {
    if (this.closed) {
      return;
    }
    if (!this.closeSent) {
      const reasonBytes = Buffer.from(reason, "utf8");
      const payload = Buffer.allocUnsafe(2 + reasonBytes.length);
      payload.writeUInt16BE(code, 0);
      reasonBytes.copy(payload, 2);
      this.writeFrame({ fin: true, opcode: OPCODES.CLOSE, payload });
      this.closeSent = true;
    }
    this.socket.end();
    if (!this.closed) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.socket.destroy();
          resolve();
        }, 2_000);
        const previous = this.onClose;
        this.onClose = (info) => {
          clearTimeout(timer);
          previous?.(info);
          resolve();
        };
      });
    }
  }

  private writeFrame(frame: WsFrame): void {
    if (this.closed || this.socket.destroyed) {
      throw new Error("websocket is closed");
    }
    // Client -> server frames are always masked (RFC 6455 §5.3).
    this.socket.write(encodeFrame(frame, { mask: true }));
  }

  private handleData(chunk: Buffer): void {
    for (const frame of this.parser.push(chunk)) {
      this.handleFrame(frame);
    }
  }

  private handleFrame(frame: WsFrame): void {
    switch (frame.opcode) {
      case OPCODES.PING:
        if (!this.closeSent && !this.closed) {
          this.socket.write(
            encodeFrame(
              { fin: true, opcode: OPCODES.PONG, payload: frame.payload },
              { mask: true },
            ),
          );
        }
        return;
      case OPCODES.PONG:
        return;
      case OPCODES.CLOSE: {
        const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : null;
        const reason = frame.payload.length > 2 ? frame.payload.subarray(2).toString("utf8") : "";
        if (!this.closeSent) {
          this.socket.write(encodeFrame(frame, { mask: true }));
          this.closeSent = true;
        }
        this.socket.end();
        this.finishClose({ code, reason });
        return;
      }
      case OPCODES.TEXT:
      case OPCODES.BINARY:
        if (frame.fin) {
          this.dispatch(frame.opcode, frame.payload);
        } else {
          this.fragmentOpcode = frame.opcode;
          this.fragments = [frame.payload];
        }
        return;
      case OPCODES.CONTINUATION: {
        if (this.fragmentOpcode === null) {
          throw new Error("unexpected continuation frame");
        }
        this.fragments.push(frame.payload);
        if (frame.fin) {
          const opcode = this.fragmentOpcode;
          const payload = Buffer.concat(this.fragments);
          this.fragmentOpcode = null;
          this.fragments = [];
          this.dispatch(opcode, payload);
        }
        return;
      }
      default:
        throw new Error(`unsupported websocket opcode: ${frame.opcode}`);
    }
  }

  private dispatch(opcode: number, payload: Buffer): void {
    if (opcode === OPCODES.TEXT) {
      this.onMessage?.(payload.toString("utf8"));
    } else {
      this.onBinary?.(payload);
    }
  }

  private fail(error: Error): void {
    this.onError?.(error);
    this.socket.destroy();
    this.finishClose({ code: null, reason: error.message });
  }

  private finishClose(info: WsCloseInfo): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.onClose?.(info);
  }
}

function validateHandshakeResponse(response: string, key: string): void {
  const lines = response.split("\r\n");
  const statusLine = lines[0] ?? "";
  if (!/^HTTP\/1\.1 101/.test(statusLine)) {
    throw new Error(`websocket upgrade rejected: ${statusLine}`);
  }
  const headers = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(":");
    if (colon > 0) {
      headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
    }
  }
  const accept = headers.get("sec-websocket-accept");
  if (accept !== computeAcceptKey(key)) {
    throw new Error("websocket handshake failed: bad Sec-WebSocket-Accept");
  }
  const upgrade = headers.get("upgrade");
  if (upgrade === undefined || upgrade.toLowerCase() !== "websocket") {
    throw new Error("websocket handshake failed: missing Upgrade: websocket");
  }
}
