import type { DiffFile, DiffHunk, DiffResult } from "@omniharness/agent-protocol";

/**
 * Diff view-model: parses hunk lines into typed rows and computes review
 * progress. Pure; the Diff tab renders the result.
 */

export type DiffLineKind = "add" | "del" | "context" | "meta";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

/** Classify raw hunk lines (unified diff body, "+" / "-" / " " / "\" prefixed). */
export function parseHunkLines(lines: string[]): DiffLine[] {
  return lines.map((line) => {
    if (line.startsWith("\\")) return { kind: "meta", text: line };
    if (line.startsWith("+")) return { kind: "add", text: line.slice(1) };
    if (line.startsWith("-")) return { kind: "del", text: line.slice(1) };
    return { kind: "context", text: line.startsWith(" ") ? line.slice(1) : line };
  });
}

export type FileDecision = "accepted" | "rejected" | "partial" | "pending";

/** Aggregate hunk decisions into a per-file decision. */
export function fileDecision(file: DiffFile): FileDecision {
  const states = file.hunks.map((h) => h.accepted);
  if (states.every((s) => s === true)) return "accepted";
  if (states.every((s) => s === false)) return "rejected";
  if (states.some((s) => s === null)) return states.some((s) => s !== null) ? "partial" : "pending";
  return "partial";
}

export interface DiffSummary {
  files: number;
  additions: number;
  deletions: number;
  decidedHunks: number;
  totalHunks: number;
  allDecided: boolean;
}

export function summarizeDiff(diff: DiffResult | null): DiffSummary {
  if (!diff) {
    return { files: 0, additions: 0, deletions: 0, decidedHunks: 0, totalHunks: 0, allDecided: true };
  }
  let additions = 0;
  let deletions = 0;
  let decided = 0;
  let total = 0;
  for (const f of diff.files) {
    additions += f.additions;
    deletions += f.deletions;
    for (const h of f.hunks) {
      total++;
      if (h.accepted !== null) decided++;
    }
  }
  return {
    files: diff.files.length,
    additions,
    deletions,
    decidedHunks: decided,
    totalHunks: total,
    allDecided: decided === total,
  };
}

export type FileStatusBadge = "A" | "M" | "D" | "R";

export function statusBadge(status: DiffFile["status"]): FileStatusBadge {
  switch (status) {
    case "added":
      return "A";
    case "modified":
      return "M";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
  }
}

/** Hunks of one file with parsed lines, ready to render. */
export interface HunkView {
  index: number;
  header: string;
  accepted: boolean | null;
  lines: DiffLine[];
}

export function hunksOf(file: DiffFile): HunkView[] {
  return file.hunks.map((h: DiffHunk) => ({
    index: h.index,
    header: h.header,
    accepted: h.accepted,
    lines: parseHunkLines(h.lines),
  }));
}
