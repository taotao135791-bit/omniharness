/**
 * Minimal YAML-frontmatter parser for the flat subset used by SKILL.md files.
 *
 * Supported: string values (bare, "double"-quoted, 'single'-quoted), numbers,
 * booleans, inline string arrays (`["a", "b"]`), and block string arrays:
 *
 *   dependencies:
 *     - foo
 *     - bar
 *
 * Anything else (nested maps, multi-line scalars, anchors, tags, non-string
 * array items) throws — fail loudly rather than silently mis-parse.
 */

export type FrontmatterValue = string | number | boolean | string[];
export type Frontmatter = Record<string, FrontmatterValue>;

export class FrontmatterError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(`frontmatter line ${line}: ${message}`);
    this.name = "FrontmatterError";
  }
}

const KEY_RE = /^[A-Za-z0-9_-]+$/;
const NUMBER_RE = /^-?\d+(\.\d+)?$/;

function parseScalar(raw: string, line: number): string | number | boolean {
  if (raw.length === 0) throw new FrontmatterError("missing value", line);
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) {
      throw new FrontmatterError("unterminated double-quoted string", line);
    }
    return raw
      .slice(1, -1)
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
  if (raw.startsWith("'")) {
    if (raw.length < 2 || !raw.endsWith("'")) {
      throw new FrontmatterError("unterminated single-quoted string", line);
    }
    return raw.slice(1, -1).replace(/''/g, "'");
  }
  // Reject YAML features outside the supported subset.
  if (/^[\][{}|>&*!%@`]/.test(raw)) {
    throw new FrontmatterError(`unsupported YAML construct: ${raw}`, line);
  }
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (NUMBER_RE.test(raw)) return Number(raw);
  return raw;
}

function parseInlineArray(raw: string, line: number): string[] {
  if (!raw.endsWith("]")) {
    throw new FrontmatterError("unterminated inline array", line);
  }
  const inner = raw.slice(1, -1).trim();
  if (inner.length === 0) return [];
  const items: string[] = [];
  for (const part of splitTopLevel(inner, line)) {
    const value = parseScalar(part.trim(), line);
    if (typeof value !== "string") {
      throw new FrontmatterError("only string items are supported in arrays", line);
    }
    items.push(value);
  }
  return items;
}

/** Split a comma list, respecting quoted segments. */
function splitTopLevel(inner: string, line: number): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (const ch of inner) {
    if (quote !== null) {
      current += ch;
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === ",") {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (quote !== null) throw new FrontmatterError("unterminated quoted string in array", line);
  parts.push(current);
  return parts;
}

/** Parse the contents of a `---` fenced frontmatter block. */
export function parseFrontmatter(text: string): Frontmatter {
  const result: Frontmatter = {};
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const lineNo = i + 1;
    const raw = lines[i] ?? "";
    const line = raw.trimEnd();
    i += 1;
    if (line.trim().length === 0 || line.trimStart().startsWith("#")) continue;
    if (/^\s/.test(line)) {
      throw new FrontmatterError("unexpected indentation (nested maps are not supported)", lineNo);
    }
    const colon = line.indexOf(":");
    if (colon === -1) throw new FrontmatterError("expected `key: value`", lineNo);
    const key = line.slice(0, colon).trim();
    if (!KEY_RE.test(key)) throw new FrontmatterError(`invalid key: ${key}`, lineNo);
    if (key in result) throw new FrontmatterError(`duplicate key: ${key}`, lineNo);
    const rest = line.slice(colon + 1).trim();

    if (rest.length === 0) {
      // Block sequence: following lines indented `- item`.
      const items: string[] = [];
      while (i < lines.length) {
        const nextRaw = lines[i] ?? "";
        const match = /^\s+-\s+(.*)$/.exec(nextRaw.trimEnd());
        if (match === null) break;
        const value = parseScalar((match[1] ?? "").trim(), i + 1);
        if (typeof value !== "string") {
          throw new FrontmatterError("only string items are supported in arrays", i + 1);
        }
        items.push(value);
        i += 1;
      }
      if (items.length === 0) {
        throw new FrontmatterError(`empty value for key: ${key}`, lineNo);
      }
      result[key] = items;
      continue;
    }
    if (rest.startsWith("[")) {
      result[key] = parseInlineArray(rest, lineNo);
      continue;
    }
    result[key] = parseScalar(rest, lineNo);
  }
  return result;
}

function needsQuoting(value: string): boolean {
  if (value.length === 0) return true;
  if (value !== value.trim()) return true;
  if (NUMBER_RE.test(value) || value === "true" || value === "false") return true;
  return /[:#"'[\]{}&*!|>%@`\n]/.test(value);
}

function serializeValue(value: FrontmatterValue): string {
  if (typeof value === "string") return needsQuoting(value) ? JSON.stringify(value) : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return `[${value.map((item) => JSON.stringify(item)).join(", ")}]`;
}

/** Serialize a flat frontmatter object back to YAML lines (no fences). */
export function serializeFrontmatter(frontmatter: Frontmatter): string {
  return Object.entries(frontmatter)
    .map(([key, value]) => `${key}: ${serializeValue(value)}`)
    .join("\n");
}
