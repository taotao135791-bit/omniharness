import { COMMANDS, type CommandSpec } from "@omniharness/ui-command-registry";

/**
 * Command-palette view-model: fuzzy ranking over the ui-command-registry.
 * Pure functions; the React overlay only renders what these return.
 */

export interface PaletteItem {
  command: CommandSpec;
  score: number;
  /** Indices into the title for highlight rendering. */
  titleMatches: number[];
}

/**
 * Subsequence fuzzy match. Returns a score (higher is better) or -1 when the
 * query is not a subsequence. Consecutive matches and word-boundary matches
 * score higher.
 */
export function fuzzyScore(query: string, target: string): { score: number; matches: number[] } {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (!q) return { score: 0, matches: [] };
  const matches: number[] = [];
  let score = 0;
  let ti = 0;
  let lastMatch = -2;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi]!;
    let found = -1;
    while (ti < t.length) {
      if (t[ti] === ch) {
        found = ti;
        ti++;
        break;
      }
      ti++;
    }
    if (found === -1) return { score: -1, matches: [] };
    matches.push(found);
    score += 1;
    if (found === lastMatch + 1) score += 2; // consecutive
    if (found === 0 || target[found - 1] === " " || target[found - 1] === ".") score += 3; // boundary
    lastMatch = found;
  }
  // Prefer shorter targets and earlier first matches.
  score -= t.length * 0.01 + matches[0]! * 0.05;
  return { score, matches };
}

/** Rank registry commands against a query, best first. */
export function rankCommands(query: string, hasSession: boolean): PaletteItem[] {
  const items: PaletteItem[] = [];
  for (const command of COMMANDS) {
    if (command.requiresSession && !hasSession) continue;
    const title = fuzzyScore(query, command.title);
    const id = fuzzyScore(query, command.id);
    const best =
      title.score === -1 && id.score === -1
        ? null
        : title.score >= id.score
          ? title
          : { score: id.score - 1, matches: [] as number[] };
    if (!best) continue;
    items.push({ command, score: best.score, titleMatches: best.matches });
  }
  items.sort((a, b) => b.score - a.score || a.command.title.localeCompare(b.command.title));
  return items;
}

/** Move a selection index by delta, wrapping within [0, length). */
export function moveSelection(index: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  return (((index + delta) % length) + length) % length;
}
