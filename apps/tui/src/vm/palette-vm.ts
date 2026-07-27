import { searchCommands, type CommandSpec } from "@omniharness/ui-command-registry";
import { truncate } from "./layout.js";

/**
 * Command palette view-model: query + fuzzy-ish filtered command list
 * (matching delegated to the registry's searchCommands).
 */
export class PaletteViewModel {
  query = "";
  matches: CommandSpec[] = [];
  selected = 0;

  constructor() {
    this.refresh();
  }

  setQuery(query: string): void {
    this.query = query;
    this.refresh();
  }

  private refresh(): void {
    this.matches = searchCommands(this.query);
    if (this.selected >= this.matches.length) this.selected = Math.max(0, this.matches.length - 1);
  }

  move(delta: number): void {
    if (this.matches.length === 0) return;
    this.selected = (this.selected + delta + this.matches.length) % this.matches.length;
  }

  selectedCommand(): CommandSpec | undefined {
    return this.matches[this.selected];
  }

  renderLines(width: number, maxVisible: number): string[] {
    const lines: string[] = [];
    lines.push(truncate(`> ${this.query}`, width));
    if (this.matches.length === 0) {
      lines.push(truncate("  no matching commands", width));
      return lines;
    }
    const visible = Math.max(1, maxVisible);
    let start = 0;
    if (this.matches.length > visible) {
      start = Math.min(
        Math.max(0, this.selected - Math.floor(visible / 2)),
        this.matches.length - visible,
      );
    }
    const end = Math.min(this.matches.length, start + visible);
    for (let i = start; i < end; i++) {
      const c = this.matches[i]!;
      const cursor = i === this.selected ? "❯ " : "  ";
      const kb = c.keybinding ? `  ${c.keybinding}` : "";
      lines.push(truncate(`${cursor}${c.title}  [${c.category}]${kb}`, width));
    }
    return lines;
  }
}
