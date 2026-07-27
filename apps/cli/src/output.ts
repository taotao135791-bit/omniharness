/**
 * Tabular output for humans, JSON for machines (--json).
 */
export function printTable(rows: Array<Record<string, unknown>>, columns?: string[]): void {
  if (rows.length === 0) {
    console.log("(none)");
    return;
  }
  const cols = columns ?? Object.keys(rows[0]!);
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)));
  const line = (cells: string[]): string =>
    cells
      .map((c, i) => c.padEnd(widths[i]!))
      .join("  ")
      .trimEnd();
  console.log(line(cols));
  console.log(widths.map((w) => "─".repeat(w)).join("  "));
  for (const row of rows) console.log(line(cols.map((c) => String(row[c] ?? ""))));
}

export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}
