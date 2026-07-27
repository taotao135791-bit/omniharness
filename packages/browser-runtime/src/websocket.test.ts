import { createServer, type Server, type Socket } from "node:net";
import { describe, expect, it, afterEach } from "vitest";
import {
  computeAcceptKey,
  encodeFrame,
  OPCODES,
  WebSocketConnection,
  WsFrameParser,
} from "./cdp/websocket.js";

describe("websocket frame codec", () => {
  it("round-trips a client-masked text frame", () => {
    const encoded = encodeFrame(
      { fin: true, opcode: OPCODES.TEXT, payload: Buffer.from("hello", "utf8") },
      { mask: true },
    );
    // Mask bit must be set on the wire for client frames (RFC 6455 §5.3).
    expect((encoded.readUInt8(1) & 0x80) !== 0).toBe(true);
    const frames = new WsFrameParser().push(encoded);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.opcode).toBe(OPCODES.TEXT);
    expect(frames[0]?.payload.toString("utf8")).toBe("hello");
  });

  it("round-trips a server-unmasked frame", () => {
    const encoded = encodeFrame(
      { fin: true, opcode: OPCODES.TEXT, payload: Buffer.from("srv", "utf8") },
      { mask: false },
    );
    expect((encoded.readUInt8(1) & 0x80) !== 0).toBe(false);
    const frames = new WsFrameParser().push(encoded);
    expect(frames[0]?.payload.toString("utf8")).toBe("srv");
  });

  it("handles 16-bit extended lengths", () => {
    const payload = Buffer.alloc(300, 0x61);
    const frames = new WsFrameParser().push(
      encodeFrame({ fin: true, opcode: OPCODES.BINARY, payload }, { mask: true }),
    );
    expect(frames[0]?.payload).toHaveLength(300);
    expect(frames[0]?.payload.equals(payload)).toBe(true);
  });

  it("handles 64-bit extended lengths", () => {
    const payload = Buffer.alloc(70_000, 0x62);
    const frames = new WsFrameParser().push(
      encodeFrame({ fin: true, opcode: OPCODES.BINARY, payload }, { mask: false }),
    );
    expect(frames[0]?.payload).toHaveLength(70_000);
    expect(frames[0]?.payload.equals(payload)).toBe(true);
  });

  it("handles frames split across pushes", () => {
    const encoded = encodeFrame(
      { fin: true, opcode: OPCODES.TEXT, payload: Buffer.from("split me", "utf8") },
      { mask: true },
    );
    const parser = new WsFrameParser();
    expect(parser.push(encoded.subarray(0, 3))).toHaveLength(0);
    expect(parser.push(encoded.subarray(3, 7))).toHaveLength(0);
    const frames = parser.push(encoded.subarray(7));
    expect(frames[0]?.payload.toString("utf8")).toBe("split me");
  });

  it("parses multiple frames from one push", () => {
    const a = encodeFrame(
      { fin: true, opcode: OPCODES.TEXT, payload: Buffer.from("a") },
      { mask: false },
    );
    const b = encodeFrame(
      { fin: true, opcode: OPCODES.TEXT, payload: Buffer.from("b") },
      { mask: false },
    );
    const frames = new WsFrameParser().push(Buffer.concat([a, b]));
    expect(frames.map((f) => f.payload.toString("utf8"))).toEqual(["a", "b"]);
  });

  it("parses ping and close frames", () => {
    const ping = new WsFrameParser().push(
      encodeFrame({ fin: true, opcode: OPCODES.PING, payload: Buffer.from("x") }, { mask: false }),
    );
    expect(ping[0]?.opcode).toBe(OPCODES.PING);

    const closePayload = Buffer.allocUnsafe(2);
    closePayload.writeUInt16BE(1000, 0);
    const close = new WsFrameParser().push(
      encodeFrame({ fin: true, opcode: OPCODES.CLOSE, payload: closePayload }, { mask: false }),
    );
    expect(close[0]?.opcode).toBe(OPCODES.CLOSE);
    expect(close[0]?.payload.readUInt16BE(0)).toBe(1000);
  });

  it("rejects frames with RSV bits set", () => {
    const bad = Buffer.from([0xc1, 0x00]); // FIN + RSV1 + text opcode
    expect(() => new WsFrameParser().push(bad)).toThrow(/RSV/);
  });

  it("computes the RFC 6455 accept key", () => {
    // Worked example from RFC 6455 §1.3.
    expect(computeAcceptKey("dGhlIHNhbXBsZSBub25jZQ==")).toBe("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
  });
});

/** Tiny loopback server used to exercise WebSocketConnection end to end. */
class LoopbackServer {
  readonly sawMaskedFrames: boolean[] = [];
  private readonly server: Server = createServer();
  private socket: Socket | null = null;
  private readonly parser = new WsFrameParser();
  onTextFrame: ((payload: Buffer) => void) | null = null;
  onFrame: ((frame: { fin: boolean; opcode: number; payload: Buffer }) => void) | null = null;

  async start(): Promise<string> {
    this.server.on("connection", (socket) => {
      this.accept(socket);
    });
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("no server address");
    }
    return `ws://127.0.0.1:${address.port}/ws`;
  }

  private accept(socket: Socket): void {
    this.socket = socket;
    socket.on("error", () => {
      // Client teardown races are expected in tests.
    });
    let head = Buffer.alloc(0);
    let upgraded = false;
    socket.on("data", (chunk) => {
      if (!upgraded) {
        head = Buffer.concat([head, chunk]);
        const end = head.indexOf("\r\n\r\n");
        if (end === -1) {
          return;
        }
        const request = head.subarray(0, end).toString("latin1");
        const key = /Sec-WebSocket-Key:\s*(\S+)/i.exec(request)?.[1];
        if (key === undefined) {
          socket.destroy();
          return;
        }
        socket.write(
          "HTTP/1.1 101 Switching Protocols\r\n" +
            "Upgrade: websocket\r\n" +
            "Connection: Upgrade\r\n" +
            `Sec-WebSocket-Accept: ${computeAcceptKey(key)}\r\n\r\n`,
        );
        upgraded = true;
        const rest = head.subarray(end + 4);
        if (rest.length > 0) {
          this.handleFrames(rest);
        }
        return;
      }
      this.handleFrames(chunk);
    });
  }

  private handleFrames(chunk: Buffer): void {
    // Record whether the raw client bytes carry the mask bit.
    if (chunk.length >= 2) {
      this.sawMaskedFrames.push((chunk.readUInt8(1) & 0x80) !== 0);
    }
    for (const frame of this.parser.push(chunk)) {
      this.onFrame?.(frame);
      if (frame.opcode === OPCODES.TEXT) {
        this.onTextFrame?.(frame.payload);
      } else if (frame.opcode === OPCODES.CLOSE) {
        this.socket?.write(encodeFrame(frame, { mask: false }));
        this.socket?.end();
      }
    }
  }

  sendText(text: string, fragment = false): void {
    const payload = Buffer.from(text, "utf8");
    if (!fragment) {
      this.socket?.write(
        encodeFrame({ fin: true, opcode: OPCODES.TEXT, payload }, { mask: false }),
      );
      return;
    }
    const cut = Math.floor(payload.length / 2);
    this.socket?.write(
      encodeFrame(
        { fin: false, opcode: OPCODES.TEXT, payload: payload.subarray(0, cut) },
        { mask: false },
      ),
    );
    this.socket?.write(
      encodeFrame(
        { fin: true, opcode: OPCODES.CONTINUATION, payload: payload.subarray(cut) },
        { mask: false },
      ),
    );
  }

  ping(payload: Buffer): void {
    this.socket?.write(encodeFrame({ fin: true, opcode: OPCODES.PING, payload }, { mask: false }));
  }

  async stop(): Promise<void> {
    this.socket?.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

describe("WebSocketConnection (loopback)", () => {
  let server: LoopbackServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it("handshakes and round-trips masked text", async () => {
    server = new LoopbackServer();
    const url = await server.start();
    server.onTextFrame = (payload) => {
      server?.sendText(`echo:${payload.toString("utf8")}`);
    };
    const ws = await WebSocketConnection.connect({ url });
    const received = new Promise<string>((resolve) => {
      ws.onMessage = resolve;
    });
    ws.sendText("ping");
    expect(await received).toBe("echo:ping");
    expect(server.sawMaskedFrames.some(Boolean)).toBe(true);
    await ws.close();
  });

  it("reassembles fragmented server messages", async () => {
    server = new LoopbackServer();
    const url = await server.start();
    const ws = await WebSocketConnection.connect({ url });
    const received = new Promise<string>((resolve) => {
      ws.onMessage = resolve;
    });
    server.sendText("fragmented message", true);
    expect(await received).toBe("fragmented message");
    await ws.close();
  });

  it("auto-responds to ping with pong", async () => {
    server = new LoopbackServer();
    const url = await server.start();
    const ws = await WebSocketConnection.connect({ url });
    const pong = new Promise<Buffer>((resolve) => {
      server!.onFrame = (frame) => {
        if (frame.opcode === OPCODES.PONG) {
          resolve(frame.payload);
        }
      };
    });
    server.ping(Buffer.from("probe"));
    expect((await pong).toString("utf8")).toBe("probe");
    await ws.close();
  });

  it("completes the close handshake with code", async () => {
    server = new LoopbackServer();
    const url = await server.start();
    const ws = await WebSocketConnection.connect({ url });
    const closed = new Promise<{ code: number | null; reason: string }>((resolve) => {
      ws.onClose = resolve;
    });
    await ws.close(1000, "done");
    const info = await closed;
    expect(info.code).toBe(1000);
  });
});
