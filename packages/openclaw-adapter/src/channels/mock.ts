import type { ChannelConnector, InboundHandler, OutboundMessage } from "./connector.js";
import type { MsgContextInput } from "../router.js";

/**
 * In-memory connector for tests and local development. Inbound messages are
 * injected directly; outbound messages are recorded.
 */
export class MockConnector implements ChannelConnector {
  readonly sent: OutboundMessage[] = [];
  private handler: InboundHandler | null = null;
  private running = false;

  constructor(
    readonly kind: string,
    readonly accountId = "default",
  ) {}

  async start(handler: InboundHandler): Promise<void> {
    this.handler = handler;
    this.running = true;
  }

  async stop(): Promise<void> {
    this.running = false;
    this.handler = null;
  }

  async send(message: OutboundMessage): Promise<void> {
    if (!this.running) throw new Error(`MockConnector(${this.kind}) not started`);
    this.sent.push(message);
  }

  /** Simulate a channel user sending a message. */
  inject(raw: MsgContextInput): void {
    if (!this.running || !this.handler) throw new Error(`MockConnector(${this.kind}) not started`);
    this.handler(raw);
  }

  get isRunning(): boolean {
    return this.running;
  }
}
