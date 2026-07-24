import type { JsonSchema } from "./types.js";

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as Record<string, unknown>);
    const kb = Object.keys(b as Record<string, unknown>);
    return (
      ka.length === kb.length &&
      ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
    );
  }
  return false;
}

function validate(schema: JsonSchema, value: unknown, path: string, errors: string[]): void {
  if (schema.type !== undefined) {
    const actual = typeOf(value);
    const matches =
      schema.type === "integer"
        ? typeof value === "number" && Number.isInteger(value)
        : schema.type === "number"
          ? typeof value === "number" && Number.isFinite(value)
          : actual === schema.type;
    if (!matches) {
      errors.push(`${path}: expected ${schema.type}, got ${actual}`);
      return; // Further checks would be noise.
    }
  }

  if (schema.enum !== undefined && !schema.enum.some((e) => deepEqual(e, value))) {
    errors.push(`${path}: value ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  }

  if (schema.type === "object" || (schema.type === undefined && typeof value === "object" && value !== null && !Array.isArray(value))) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return;
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in obj)) {
        errors.push(`${path}: missing required property "${key}"`);
      }
    }
    const properties = schema.properties ?? {};
    for (const [key, propSchema] of Object.entries(properties)) {
      if (key in obj) {
        validate(propSchema, obj[key], `${path}.${key}`, errors);
      }
    }
    for (const key of Object.keys(obj)) {
      if (key in properties) continue;
      const ap = schema.additionalProperties;
      if (ap === false) {
        errors.push(`${path}: additional property "${key}" is not allowed`);
      } else if (typeof ap === "object") {
        validate(ap, obj[key], `${path}.${key}`, errors);
      }
    }
  }

  if ((schema.type === "array" || Array.isArray(value)) && schema.items !== undefined && Array.isArray(value)) {
    value.forEach((item, i) => validate(schema.items!, item, `${path}[${i}]`, errors));
  }
}

/** Validates `args` against the JSON Schema subset used by tool definitions. */
export function validateArgs(schema: JsonSchema, args: unknown): ValidationResult {
  const errors: string[] = [];
  validate(schema, args, "args", errors);
  return { ok: errors.length === 0, errors };
}
