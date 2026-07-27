/**
 * Structured, redacting logger. All daemon subsystems log through this;
 * output is NDJSON to file + optional stderr. Secrets are stripped by pattern
 * before anything is written.
 */
import fs from "node:fs";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** Patterns that must never reach disk. */
const SECRET_PATTERNS: RegExp[] = [
  /\b(sk|pk|key|token|secret|password|apikey|api[-_]?key)[-_:= ]+[A-Za-z0-9_\-./+=]{8,}/gi,
  /\bBearer\s+[A-Za-z0-9_\-./+=]{8,}/gi,
  /\b[A-Za-z0-9_-]{32,}\b/g, // long opaque blobs (api keys, session tokens)
];

export function redact(input: string): string {
  let out = input;
  for (const re of SECRET_PATTERNS) out = out.replace(re, (m) => `[REDACTED:${m.length}]`);
  return out;
}

export interface LogRecord {
  at: string;
  level: LogLevel;
  subsystem: string;
  message: string;
  context?: Record<string, unknown>;
}

export type LogSink = (record: LogRecord) => void;

export class Logger {
  constructor(
    private readonly subsystem: string,
    private readonly minLevel: LogLevel,
    private readonly sink: LogSink,
  ) {}

  child(subsystem: string): Logger {
    return new Logger(`${this.subsystem}:${subsystem}`, this.minLevel, this.sink);
  }

  log(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return;
    const safeContext: Record<string, unknown> | undefined = context
      ? Object.fromEntries(
          Object.entries(context).map(([k, v]) => [k, typeof v === "string" ? redact(v) : v]),
        )
      : undefined;
    this.sink({
      at: new Date().toISOString(),
      level,
      subsystem: this.subsystem,
      message: redact(message),
      ...(safeContext ? { context: safeContext } : {}),
    });
  }

  debug(msg: string, ctx?: Record<string, unknown>): void {
    this.log("debug", msg, ctx);
  }
  info(msg: string, ctx?: Record<string, unknown>): void {
    this.log("info", msg, ctx);
  }
  warn(msg: string, ctx?: Record<string, unknown>): void {
    this.log("warn", msg, ctx);
  }
  error(msg: string, ctx?: Record<string, unknown>): void {
    this.log("error", msg, ctx);
  }
}

/** NDJSON file sink with size rotation. */
export function createNdjsonSink(filePath: string, maxBytes = 10_000_000): LogSink {
  return (record) => {
    try {
      const stat = fs.existsSync(filePath) ? fs.statSync(filePath) : null;
      if (stat && stat.size > maxBytes) {
        fs.renameSync(filePath, `${filePath}.1`);
      }
      fs.appendFileSync(filePath, JSON.stringify(record) + "\n");
    } catch {
      /* logging must never crash the daemon */
    }
  };
}

export function createStderrSink(): LogSink {
  return (record) => {
    const ctx = record.context ? ` ${JSON.stringify(record.context)}` : "";
    process.stderr.write(
      `${record.at} [${record.level}] ${record.subsystem}: ${record.message}${ctx}\n`,
    );
  };
}
