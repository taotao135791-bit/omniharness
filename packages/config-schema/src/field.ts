/**
 * A tiny field-definition system. Every configurable thing in OmniHarness is
 * declared once as a FieldDef list, and everything else — validation, defaults,
 * CLI flags, TUI/GUI forms, generated docs, migrations — is derived from it.
 * There is exactly one implementation; nothing can drift.
 */

export type FieldType = "string" | "number" | "boolean" | "enum" | "string[]" | "json";

export type FieldScope = "global" | "profile" | "workspace" | "project" | "session";

export interface FieldDef {
  /** Dot path inside the settings object, e.g. "daemon.port". */
  key: string;
  type: FieldType;
  description: string;
  default: unknown;
  /** For type "enum". */
  enumValues?: readonly string[];
  /** For type "number". */
  min?: number;
  max?: number;
  /** Sensitive fields are never written to plain config files; the secret store holds them. */
  sensitive?: boolean;
  /** The broadest scope at which this field may be overridden. */
  scope: FieldScope;
  /** CLI flag name override (defaults to the key with dots replaced by dashes). */
  cliFlag?: string;
}

export interface ValidationError {
  key: string;
  message: string;
}

export type SettingsObject = Record<string, unknown>;

/** Get a value at a dot path. */
export function getPath(obj: SettingsObject, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Set a value at a dot path, creating intermediate objects. */
export function setPath(obj: SettingsObject, path: string, value: unknown): void {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    if (typeof cur[part] !== "object" || cur[part] === null) cur[part] = {};
    cur = cur[part] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}

/** Build the full default settings object from a schema. */
export function defaults(schema: readonly FieldDef[]): SettingsObject {
  const out: SettingsObject = {};
  for (const field of schema) {
    setPath(out, field.key, structuredClone(field.default));
  }
  return out;
}

function validateValue(field: FieldDef, value: unknown): string | null {
  switch (field.type) {
    case "string":
      return typeof value === "string" ? null : "expected a string";
    case "number": {
      if (typeof value !== "number" || Number.isNaN(value)) return "expected a number";
      if (field.min !== undefined && value < field.min) return `must be >= ${field.min}`;
      if (field.max !== undefined && value > field.max) return `must be <= ${field.max}`;
      return null;
    }
    case "boolean":
      return typeof value === "boolean" ? null : "expected a boolean";
    case "enum":
      return typeof value === "string" && field.enumValues?.includes(value)
        ? null
        : `expected one of: ${(field.enumValues ?? []).join(", ")}`;
    case "string[]":
      return Array.isArray(value) && value.every((v) => typeof v === "string")
        ? null
        : "expected an array of strings";
    case "json":
      return null;
  }
}

/** Validate a (partial or full) settings object against the schema. */
export function validate(schema: readonly FieldDef[], obj: SettingsObject): ValidationError[] {
  const errors: ValidationError[] = [];
  const knownKeys = new Set(schema.map((f) => f.key));
  for (const field of schema) {
    const value = getPath(obj, field.key);
    if (value === undefined) continue; // missing = default applies
    const err = validateValue(field, value);
    if (err) errors.push({ key: field.key, message: err });
  }
  // Flag unknown keys at the top two levels to catch typos.
  for (const key of Object.keys(obj)) {
    const isKnown = [...knownKeys].some((k) => k === key || k.startsWith(key + "."));
    if (!isKnown) errors.push({ key, message: "unknown settings key" });
  }
  return errors;
}

/** Deep-merge an override object onto a base object (arrays replace, objects merge). */
export function merge(base: SettingsObject, override: SettingsObject): SettingsObject {
  const out: SettingsObject = structuredClone(base);
  const walk = (dst: Record<string, unknown>, src: Record<string, unknown>): void => {
    for (const [k, v] of Object.entries(src)) {
      if (
        v !== null &&
        typeof v === "object" &&
        !Array.isArray(v) &&
        typeof dst[k] === "object" &&
        dst[k] !== null &&
        !Array.isArray(dst[k])
      ) {
        walk(dst[k] as Record<string, unknown>, v as Record<string, unknown>);
      } else {
        dst[k] = structuredClone(v);
      }
    }
  };
  walk(out, override);
  return out;
}

/** Render the schema as Markdown documentation. */
export function toMarkdownDocs(schema: readonly FieldDef[], title: string): string {
  const lines = [
    `# ${title}`,
    "",
    "| Key | Type | Default | Scope | Description |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const f of schema) {
    const def =
      f.type === "string" || f.type === "enum"
        ? `\`"${String(f.default)}"\``
        : `\`${JSON.stringify(f.default)}\``;
    const type = f.type === "enum" ? `enum(${(f.enumValues ?? []).join("\\|")})` : f.type;
    lines.push(`| \`${f.key}\` | ${type} | ${def} | ${f.scope} | ${f.description} |`);
  }
  return lines.join("\n") + "\n";
}

/** Parse `--flag value` CLI arguments for schema fields into a partial settings object. */
export function parseCliArgs(
  schema: readonly FieldDef[],
  argv: readonly string[],
): { settings: SettingsObject; errors: ValidationError[] } {
  const settings: SettingsObject = {};
  const errors: ValidationError[] = [];
  const byFlag = new Map<string, FieldDef>();
  for (const f of schema) {
    byFlag.set(f.cliFlag ?? f.key.replaceAll(".", "-"), f);
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    const flag = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const field = byFlag.get(flag);
    if (!field) {
      errors.push({ key: flag, message: "unknown flag" });
      continue;
    }
    let raw: string;
    if (eq !== -1) {
      raw = arg.slice(eq + 1);
    } else if (field.type === "boolean") {
      raw = "true";
    } else {
      const next = argv[++i];
      if (next === undefined) {
        errors.push({ key: flag, message: "missing value" });
        continue;
      }
      raw = next;
    }
    let value: unknown;
    if (field.type === "number") value = Number(raw);
    else if (field.type === "boolean") value = raw === "true" || raw === "1";
    else if (field.type === "string[]") value = raw.split(",").map((s) => s.trim());
    else value = raw;
    const err = validateValue(field, value);
    if (err) errors.push({ key: field.key, message: err });
    else setPath(settings, field.key, value);
  }
  return { settings, errors };
}
