import { truncate } from "./layout.js";

export interface ListRow {
  /** Stable id used by actions. */
  id: string;
  /** Primary text (left column). */
  label: string;
  /** Secondary text (right of label, dimmed by the view). */
  detail: string;
  /** Header rows are not selectable and render without a cursor. */
  header?: boolean;
}

/**
 * Shared selection + windowed layout for list-based views. Views add color;
 * this class only produces the plain-text layout so tests can assert on it.
 */
export class SelectableList {
  rows: ListRow[] = [];
  selected = 0;

  setRows(rows: ListRow[]): void {
    this.rows = rows;
    if (this.selected >= rows.length) this.selected = Math.max(0, rows.length - 1);
    if (this.rows[this.selected]?.header) this.move(1);
  }

  selectedRow(): ListRow | undefined {
    return this.rows[this.selected];
  }

  move(delta: number): void {
    if (this.rows.length === 0) return;
    let next = this.selected;
    for (let i = 0; i < this.rows.length; i++) {
      next = (next + delta + this.rows.length) % this.rows.length;
      if (!this.rows[next]?.header) break;
    }
    this.selected = next;
  }

  selectById(id: string): boolean {
    const idx = this.rows.findIndex((r) => r.id === id && !r.header);
    if (idx === -1) return false;
    this.selected = idx;
    return true;
  }

  /**
   * Render rows within a window of `maxVisible` around the selection.
   * Selected rows get a "❯ " prefix; headers render dimmed markers later.
   */
  renderLines(width: number, maxVisible: number): string[] {
    if (this.rows.length === 0) return [truncate("  (empty)", width)];
    const visible = Math.max(1, maxVisible);
    let start = 0;
    if (this.rows.length > visible) {
      start = Math.min(
        Math.max(0, this.selected - Math.floor(visible / 2)),
        this.rows.length - visible,
      );
    }
    const end = Math.min(this.rows.length, start + visible);
    const lines: string[] = [];
    if (start > 0) lines.push(truncate(`  ↑ ${start} more`, width));
    for (let i = start; i < end; i++) {
      const r = this.rows[i]!;
      if (r.header) {
        lines.push(truncate(`  ${r.label}`, width));
        continue;
      }
      const cursor = i === this.selected ? "❯ " : "  ";
      const detail = r.detail ? `  ${r.detail}` : "";
      lines.push(truncate(`${cursor}${r.label}${detail}`, width));
    }
    if (end < this.rows.length) lines.push(truncate(`  ↓ ${this.rows.length - end} more`, width));
    return lines;
  }
}
