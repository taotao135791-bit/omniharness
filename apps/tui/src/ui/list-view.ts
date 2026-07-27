import type { Component } from "@earendil-works/pi-tui";
import { matchesKey } from "@earendil-works/pi-tui";
import { bold, dim, fg } from "../theme.js";
import type { SelectableList } from "../vm/selectable-list.js";

export interface ListVmLike {
  readonly list: SelectableList;
  renderLines(width: number, maxVisible: number): string[];
}

/** Style a plain VM line for display: cursor rows cyan, headers dim-bold. */
export function styleLine(line: string): string {
  if (line.startsWith("❯")) return bold(fg.cyan(line));
  if (line.startsWith("─")) return dim(bold(line));
  if (line.startsWith("  ↑") || line.startsWith("  ↓")) return dim(line);
  return line;
}

/**
 * Generic keyboard-navigable list view. Up/down (and j/k) move the VM
 * selection; every other key is delegated to the view-specific handler.
 */
export class ListViewComponent implements Component {
  focused = false;

  constructor(
    protected readonly vm: ListVmLike,
    protected readonly onKey: (data: string) => void,
    private readonly maxVisible = 20,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    return this.vm.renderLines(width, this.maxVisible).map(styleLine);
  }

  handleInput(data: string): void {
    if (matchesKey(data, "up") || data === "k") {
      this.vm.list.move(-1);
      return;
    }
    if (matchesKey(data, "down") || data === "j") {
      this.vm.list.move(1);
      return;
    }
    this.onKey(data);
  }
}
