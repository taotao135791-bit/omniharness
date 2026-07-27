import type { DiffFile, DiffResult } from "@omniharness/agent-protocol";
import { truncate } from "./layout.js";
import { SelectableList, type ListRow } from "./selectable-list.js";

const STATUS_ICON: Record<DiffFile["status"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
};

function fileAccepted(file: DiffFile): boolean | null {
  if (file.hunks.every((h) => h.accepted === true)) return true;
  if (file.hunks.every((h) => h.accepted === false)) return false;
  return null;
}

/**
 * Diff review view-model. Two-level list: files, and (when a file is
 * expanded) its hunks as sub-rows. Selection ids: "f:<path>" / "h:<path>:<index>".
 */
export class DiffViewModel {
  files: DiffFile[] = [];
  truncatedResult = false;
  loading = false;
  error: string | null = null;
  expandedFile: string | null = null;
  readonly list = new SelectableList();

  setDiff(result: DiffResult): void {
    this.files = result.files;
    this.truncatedResult = result.truncated;
    this.loading = false;
    this.error = null;
    this.rebuildRows();
  }

  setError(message: string): void {
    this.loading = false;
    this.error = message;
  }

  private rebuildRows(): void {
    const rows: ListRow[] = [];
    for (const f of this.files) {
      const acc = fileAccepted(f);
      const mark = acc === true ? "✓" : acc === false ? "✗" : " ";
      const expanded = this.expandedFile === f.path;
      rows.push({
        id: `f:${f.path}`,
        label: `${expanded ? "▾" : "▸"} [${mark}] ${STATUS_ICON[f.status]} ${f.path}`,
        detail: `+${f.additions} -${f.deletions}`,
      });
      if (expanded) {
        for (const h of f.hunks) {
          const hmark = h.accepted === true ? "✓" : h.accepted === false ? "✗" : " ";
          rows.push({
            id: `h:${f.path}:${h.index}`,
            label: `    [${hmark}] hunk ${h.index}: ${h.header}`,
            detail: `${h.lines.length} lines`,
          });
        }
      }
    }
    this.list.setRows(rows);
  }

  /** Enter on a file toggles expansion; on a hunk it's a no-op (a/d act). */
  toggleSelected(): void {
    const row = this.list.selectedRow();
    if (!row) return;
    if (row.id.startsWith("f:")) {
      const path = row.id.slice(2);
      this.expandedFile = this.expandedFile === path ? null : path;
      this.rebuildRows();
      if (this.expandedFile) this.list.selectById(`f:${path}`);
    }
  }

  /** Returns accept/reject target for the selected row, or null. */
  selectedTarget(): { file?: string; hunkIndex?: number } | null {
    const row = this.list.selectedRow();
    if (!row) return null;
    if (row.id.startsWith("f:")) return { file: row.id.slice(2) };
    if (row.id.startsWith("h:")) {
      const rest = row.id.slice(2);
      const sep = rest.lastIndexOf(":");
      return { file: rest.slice(0, sep), hunkIndex: Number(rest.slice(sep + 1)) };
    }
    return null;
  }

  /** Optimistically mark a target accepted/rejected after the RPC succeeds. */
  markResolved(target: { file?: string; hunkIndex?: number }, accepted: boolean): void {
    for (const f of this.files) {
      if (target.file !== undefined && f.path !== target.file) continue;
      for (const h of f.hunks) {
        if (target.hunkIndex !== undefined && h.index !== target.hunkIndex) continue;
        h.accepted = accepted;
      }
    }
    this.rebuildRows();
  }

  renderLines(width: number, maxVisible: number): string[] {
    if (this.loading) return ["  loading diff…"];
    if (this.error) return [truncate(`  error: ${this.error}`, width)];
    if (this.files.length === 0) return ["  no changes"];
    const lines = this.list.renderLines(width, maxVisible);
    if (this.truncatedResult) lines.push(truncate("  (diff truncated by daemon)", width));
    return lines;
  }

  /** Full hunk text for the detail pane of the selected hunk. */
  selectedHunkLines(): string[] {
    const t = this.selectedTarget();
    if (!t || t.file === undefined || t.hunkIndex === undefined) return [];
    const file = this.files.find((f) => f.path === t.file);
    const hunk = file?.hunks.find((h) => h.index === t.hunkIndex);
    return hunk ? [hunk.header, ...hunk.lines] : [];
  }
}
