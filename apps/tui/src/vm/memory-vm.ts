import type { MemoryEntry } from "@omniharness/agent-protocol";
import { fmtDate, truncate } from "./layout.js";
import { SelectableList, type ListRow } from "./selectable-list.js";

/**
 * Memory view-model: approved entries + pending proposals (agent-proposed,
 * not yet approved). Search is driven by the controller via memory.search /
 * memory.list; this VM holds results and selection.
 */
export class MemoryViewModel {
  memories: MemoryEntry[] = [];
  total = 0;
  searchText = "";
  loading = false;
  error: string | null = null;
  readonly list = new SelectableList();

  setMemories(memories: MemoryEntry[], total: number): void {
    this.memories = memories;
    this.total = total;
    this.loading = false;
    this.error = null;
    this.list.setRows(this.buildRows());
  }

  setError(message: string): void {
    this.loading = false;
    this.error = message;
  }

  private buildRows(): ListRow[] {
    const pending = this.memories.filter((m) => !m.approvedByUser);
    const approved = this.memories.filter((m) => m.approvedByUser);
    const rows: ListRow[] = [];
    if (pending.length > 0) {
      rows.push({
        id: "h:pending",
        label: `pending proposals (${pending.length})`,
        detail: "",
        header: true,
      });
      for (const m of pending) {
        rows.push({
          id: m.id,
          label: `? ${m.summary}`,
          detail: `${m.kind} ${fmtDate(m.createdAt)}`,
        });
      }
    }
    if (approved.length > 0) {
      rows.push({
        id: "h:approved",
        label: `approved (${approved.length})`,
        detail: "",
        header: true,
      });
      for (const m of approved) {
        rows.push({
          id: m.id,
          label: `✓ ${m.summary}`,
          detail: `${m.kind} ${fmtDate(m.createdAt)}`,
        });
      }
    }
    return rows;
  }

  selected(): MemoryEntry | undefined {
    const row = this.list.selectedRow();
    if (!row || row.header) return undefined;
    return this.memories.find((m) => m.id === row.id);
  }

  get pendingCount(): number {
    return this.memories.filter((m) => !m.approvedByUser).length;
  }

  renderLines(width: number, maxVisible: number): string[] {
    const lines: string[] = [];
    lines.push(
      truncate(`  search: ${this.searchText || "(type to filter, enter to search)"}`, width),
    );
    lines.push("");
    if (this.loading) return [...lines, "  loading memories…"];
    if (this.error) return [...lines, truncate(`  error: ${this.error}`, width)];
    if (this.memories.length === 0) return [...lines, "  no memories"];
    return [...lines, ...this.list.renderLines(width, maxVisible)];
  }
}
