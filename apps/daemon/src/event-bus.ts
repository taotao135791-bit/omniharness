import type { DomainEvent } from "@omniharness/agent-protocol";

/** Distributive Omit over the DomainEvent union (plain Omit collapses unions). */
export type EventInput = DomainEvent extends infer E
  ? E extends DomainEvent
    ? Omit<E, "seq" | "at">
    : never
  : never;
import type { OmniDatabase } from "@omniharness/session-store";

/**
 * The daemon's event backbone. Every domain event is FIRST appended to the
 * durable event log (getting its monotonic seq), THEN broadcast to connected
 * clients. Reconnecting clients replay via `since()`.
 */
export class EventBus {
  private listeners = new Set<(event: DomainEvent) => void>();

  constructor(private readonly db: OmniDatabase) {}

  /** Persist + broadcast. Returns the assigned seq. */
  emit(event: EventInput): number {
    const seq = this.db.events.append(event.type, {
      ...event,
      at: new Date().toISOString(),
    });
    const full = { ...event, seq, at: new Date().toISOString() } as unknown as DomainEvent;
    for (const listener of this.listeners) {
      try {
        listener(full);
      } catch {
        /* one bad client must not break the bus */
      }
    }
    return seq;
  }

  subscribe(listener: (event: DomainEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Events after `seq`, for reconnect catch-up. */
  since(seq: number, limit = 1000): { events: DomainEvent[]; latestSeq: number } {
    const rows = this.db.events.since(seq, limit);
    return {
      events: rows.map((r) => ({ ...(r.payload as object), seq: r.seq, at: r.at }) as unknown as DomainEvent),
      latestSeq: this.db.events.latestSeq(),
    };
  }

  latestSeq(): number {
    return this.db.events.latestSeq();
  }
}
