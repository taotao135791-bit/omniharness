import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

/**
 * Plain-text layout helpers shared by all view-models. View-models produce
 * ANSI-free lines so tests assert on layout, not styling; the view layer
 * applies color on top.
 */

/** Word-wrap plain text to a width. Returns [] for empty text. */
export function wrapPlain(text: string, width: number): string[] {
  if (width < 1) return [];
  const out: string[] = [];
  for (const rawLine of text.split("\n")) {
    if (rawLine === "") {
      out.push("");
      continue;
    }
    out.push(...wrapTextWithAnsi(rawLine, width));
  }
  return out;
}

/** Truncate a single line to width with an ellipsis. */
export function truncate(line: string, width: number): string {
  if (width < 1) return "";
  if ([...line].length <= width && !line.includes("\u001b")) return line;
  const t = truncateToWidth(line, width, "");
  return t;
}

/** Join parts with a separator, then truncate to width. */
export function row(width: number, ...parts: string[]): string {
  return truncate(parts.join("  "), width);
}

/** Format a token count compactly: 1234 -> "1.2k". */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** Format USD cost compactly. */
export function fmtCost(usd: number | undefined | null): string {
  if (usd === undefined || usd === null) return "$0.00";
  if (usd < 0.01 && usd > 0) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

/** ISO timestamp -> short local HH:MM. */
export function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** ISO timestamp -> short local date YYYY-MM-DD. */
export function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Summarize tool-call arguments to a short one-line hint. */
export function summarizeArgs(argumentsJson: string, maxLen = 60): string {
  try {
    const parsed: unknown = JSON.parse(argumentsJson);
    if (typeof parsed !== "object" || parsed === null) return truncate(String(parsed), maxLen);
    const obj = parsed as Record<string, unknown>;
    // Common shapes: {command}, {path}, {file_path}, {pattern}, {query}, {url}
    for (const key of ["command", "path", "file_path", "filePath", "pattern", "query", "url", "name"]) {
      const v = obj[key];
      if (typeof v === "string" && v) return truncate(v, maxLen);
    }
    const keys = Object.keys(obj);
    return truncate(keys.length > 0 ? keys.join(", ") : "", maxLen);
  } catch {
    return truncate(argumentsJson, maxLen);
  }
}
