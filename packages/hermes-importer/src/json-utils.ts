import { readFileSync } from "node:fs";

/** Narrow unknown JSON values without `any`. */

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

export function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every((item) => typeof item === "string") ? (value as string[]) : undefined;
}

export type ReadJsonResult = { ok: true; value: unknown } | { ok: false; error: string };

/** Read + JSON.parse a file; never throws. Missing file → error result. */
export function readJsonFile(path: string): ReadJsonResult {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    return { ok: false, error: `cannot read file: ${errMessage(err)}` };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (err) {
    return { ok: false, error: `invalid JSON: ${errMessage(err)}` };
  }
}

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
