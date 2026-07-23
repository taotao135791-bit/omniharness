import type { DatabaseSync } from "node:sqlite";
import { nowIso, type EventSeq } from "@omniharness/shared-types";
import { allRows, getRow, jparse, jstr, num, txt } from "./helpers.js";
import type { StoredEvent } from "./types.js";

interface EventRow {
  seq: number;
  at: string;
  type: string;
  payload: string;
}

function rowToEvent(row: EventRow): StoredEvent {
  return {
    seq: row.seq as EventSeq,
    at: txt(row.at),
    type: txt(row.type),
    payload: jparse<unknown>(row.payload, null),
  };
}

/**
 * Append-only event log. `seq` (INTEGER PRIMARY KEY AUTOINCREMENT) is the
 * daemon-wide total ordering used for client reconnect catch-up: SQLite's
 * AUTOINCREMENT guarantees monotonically increasing values across reopens
 * (via sqlite_sequence), so no separate meta table is needed.
 */
export class EventLog {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** Append an event and return its assigned seq. */
  append(type: string, payload: unknown, at: string = nowIso()): EventSeq {
    const res = this.db
      .prepare("INSERT INTO event_log (at, type, payload) VALUES (?, ?, ?)")
      .run(at, type, jstr(payload));
    return Number(res.lastInsertRowid) as EventSeq;
  }

  /** Fetch up to `limit` events with seq strictly greater than `afterSeq`, ordered by seq. */
  since(afterSeq: EventSeq | number, limit = 1000): StoredEvent[] {
    const rows = allRows<EventRow>(
      this.db.prepare(
        "SELECT seq, at, type, payload FROM event_log WHERE seq > ? ORDER BY seq LIMIT ?",
      ),
      afterSeq,
      limit,
    );
    return rows.map(rowToEvent);
  }

  /** The highest seq written so far; 0 when the log is empty. Survives reopen. */
  latestSeq(): EventSeq {
    const row = getRow<{ v: number | null }>(
      this.db.prepare("SELECT MAX(seq) AS v FROM event_log"),
    );
    return (row?.v === null || row === undefined ? 0 : num(row.v)) as EventSeq;
  }

  /** Total number of events in the log. */
  count(): number {
    const row = getRow<{ c: number }>(this.db.prepare("SELECT COUNT(*) AS c FROM event_log"));
    return row ? num(row.c) : 0;
  }
}
