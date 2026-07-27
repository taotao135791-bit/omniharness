import { getPath, validate, type FieldDef } from "../schema.js";

/**
 * Settings view-model: groups the schema into sections and converts raw
 * form input into validated values. Pure; React form just renders it.
 */

export interface SettingsGroup {
  name: string;
  fields: FieldDef[];
}

/** Group schema fields by their top-level key prefix, preserving schema order. */
export function groupFields(schema: readonly FieldDef[]): SettingsGroup[] {
  const groups: SettingsGroup[] = [];
  const byName = new Map<string, FieldDef[]>();
  for (const field of schema) {
    const name = field.key.split(".")[0] ?? field.key;
    let list = byName.get(name);
    if (!list) {
      list = [];
      byName.set(name, list);
      groups.push({ name, fields: list });
    }
    list.push(field);
  }
  return groups;
}

/**
 * Effective value for a field: the stored settings value when present,
 * otherwise the schema default.
 */
export function fieldValue(field: FieldDef, settings: Record<string, unknown>): unknown {
  const v = getPath(settings, field.key);
  return v === undefined ? field.default : v;
}

export interface FieldEdit {
  ok: boolean;
  value?: unknown;
  error?: string;
}

/**
 * Coerce a raw form input string into the field's type and validate it.
 * Booleans arrive already coerced (checkbox); pass them through.
 */
export function coerceFieldInput(field: FieldDef, raw: string | boolean): FieldEdit {
  let value: unknown;
  if (field.type === "boolean") {
    value = typeof raw === "boolean" ? raw : raw === "true";
  } else if (field.type === "number") {
    const n = Number(raw);
    if (typeof raw === "string" && raw.trim() === "") return { ok: false, error: "required" };
    if (Number.isNaN(n)) return { ok: false, error: "expected a number" };
    if (field.min !== undefined && n < field.min)
      return { ok: false, error: `must be >= ${field.min}` };
    if (field.max !== undefined && n > field.max)
      return { ok: false, error: `must be <= ${field.max}` };
    value = n;
  } else if (field.type === "string[]") {
    value = String(raw)
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  } else if (field.type === "json") {
    try {
      value = JSON.parse(String(raw));
    } catch {
      return { ok: false, error: "invalid JSON" };
    }
  } else {
    value = String(raw);
    if (field.type === "enum" && !(field.enumValues ?? []).includes(value as string)) {
      return { ok: false, error: `expected one of: ${(field.enumValues ?? []).join(", ")}` };
    }
  }
  // Final check against the real schema validator (partial object with one key).
  const probe: Record<string, unknown> = {};
  const parts = field.key.split(".");
  let cur = probe;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]!;
    cur[p] = {};
    cur = cur[p] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
  const errors = validate([field], probe);
  if (errors.length > 0) return { ok: false, error: errors[0]!.message };
  return { ok: true, value };
}

/** Display string for the current effective value of a field. */
export function displayValue(field: FieldDef, settings: Record<string, unknown>): string {
  const v = fieldValue(field, settings);
  if (field.type === "boolean") return v === true ? "true" : "false";
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "object" && v !== null) return JSON.stringify(v);
  return String(v ?? "");
}
