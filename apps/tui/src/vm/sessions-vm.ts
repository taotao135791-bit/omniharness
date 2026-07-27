import type { Session } from "@omniharness/agent-protocol";
import { fmtDate, truncate } from "./layout.js";
import { SelectableList } from "./selectable-list.js";

export const SESSION_PAGE_SIZE = 50;

/**
 * Sessions list view-model: paginated session.list data + selection.
 * The controller performs the RPCs and feeds results here.
 */
export class SessionsViewModel {
  sessions: Session[] = [];
  total = 0;
  offset = 0;
  loading = false;
  error: string | null = null;
  readonly list = new SelectableList();

  get hasMore(): boolean {
    return this.offset + this.sessions.length < this.total;
  }

  setPage(sessions: Session[], total: number, offset: number): void {
    this.sessions = sessions;
    this.total = total;
    this.offset = offset;
    this.loading = false;
    this.error = null;
    this.list.setRows(
      sessions.map((s) => ({
        id: s.id,
        label: `${s.title || "(untitled)"}${s.status === "archived" ? " [archived]" : ""}`,
        detail: `${s.tags.length > 0 ? `#${s.tags.join(" #")}  ` : ""}${fmtDate(s.updatedAt)}`,
      })),
    );
  }

  setError(message: string): void {
    this.loading = false;
    this.error = message;
  }

  selectedSession(): Session | undefined {
    const row = this.list.selectedRow();
    if (!row) return undefined;
    return this.sessions.find((s) => s.id === row.id);
  }

  renderLines(width: number, maxVisible: number): string[] {
    if (this.loading) return ["  loading sessions…"];
    if (this.error) return [truncate(`  error: ${this.error}`, width)];
    if (this.sessions.length === 0) return ["  no sessions yet — press [n] to create one"];
    const lines = this.list.renderLines(width, maxVisible);
    if (this.hasMore) lines.push(truncate("  [>] next page", width));
    if (this.offset > 0) lines.push(truncate("  [<] previous page", width));
    return lines;
  }
}
