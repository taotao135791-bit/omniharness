import type { SQLInputValue, SQLOutputValue, StatementSync } from "node:sqlite";

/** A raw SQLite row as returned by node:sqlite. */
export type Row = Record<string, SQLOutputValue>;

/** JSON-encode a value for a TEXT column. */
export function jstr(value: unknown): string {
  return JSON.stringify(value);
}

/** Decode a JSON TEXT column. Returns fallback when the column is NULL. */
export function jparse<T>(value: SQLOutputValue, fallback: T): T {
  if (value === null) return fallback;
  return JSON.parse(value as string) as T;
}

/** Read a TEXT column. */
export function txt(value: SQLOutputValue): string {
  return value as string;
}

/** Read a nullable TEXT column. */
export function txtOrNull(value: SQLOutputValue): string | null {
  return value === null ? null : (value as string);
}

/** Read an INTEGER column as a JS number. */
export function num(value: SQLOutputValue): number {
  return Number(value);
}

/** Read a nullable REAL/INTEGER column. */
export function numOrNull(value: SQLOutputValue): number | null {
  return value === null ? null : Number(value);
}

/** Read a 0/1 INTEGER column as boolean. */
export function bool(value: SQLOutputValue): boolean {
  return Number(value) === 1;
}

/** Encode a boolean for an INTEGER column. */
export function bit(value: boolean): number {
  return value ? 1 : 0;
}

/** Run a SELECT expected to return at most one row, cast to `R`. */
export function getRow<R>(stmt: StatementSync, ...params: SQLInputValue[]): R | undefined {
  const row = stmt.get(...params);
  return row === undefined ? undefined : (row as unknown as R);
}

/** Run a SELECT and cast all rows to `R`. */
export function allRows<R>(stmt: StatementSync, ...params: SQLInputValue[]): R[] {
  return stmt.all(...params) as unknown as R[];
}
