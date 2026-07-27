import {
  Input,
  matchesKey,
  SelectList,
  type Component,
  type Focusable,
  type SelectItem,
} from "@earendil-works/pi-tui";
import { PaletteViewModel } from "../vm/palette-vm.js";
import type { CommandSpec } from "@omniharness/ui-command-registry";
import { bold, dim, fg, selectTheme } from "../theme.js";
import { truncate } from "../vm/layout.js";

export interface OverlayProps {
  onClose: () => void;
}

/** Single-line text prompt shown as an overlay (rename, search, tags, ...). */
export class InputOverlay implements Component, Focusable {
  focused = false;
  private readonly input = new Input();

  constructor(
    private readonly title: string,
    private readonly onSubmit: (text: string) => void,
    private readonly onClose: () => void,
    initial = "",
  ) {
    this.input.setValue(initial);
    this.input.onSubmit = (value) => {
      this.onClose();
      this.onSubmit(value.trim());
    };
    this.input.onEscape = () => this.onClose();
  }

  invalidate(): void {
    this.input.invalidate();
  }

  render(width: number): string[] {
    const inner = Math.max(10, width - 2);
    return [
      fg.cyan(truncate(` ${this.title}`, width)),
      ...this.input.render(inner),
      dim(truncate(" enter confirm · esc cancel", width)),
    ];
  }

  handleInput(data: string): void {
    this.input.handleInput(data);
  }
}

/** Generic picker overlay (workspaces, models, roles, checkpoints, ...). */
export class SelectOverlay implements Component, Focusable {
  focused = false;
  private readonly list: SelectList;

  constructor(
    private readonly title: string,
    items: SelectItem[],
    onSelect: (item: SelectItem) => void,
    private readonly onClose: () => void,
  ) {
    this.list = new SelectList(items, Math.min(10, Math.max(3, items.length)), selectTheme);
    this.list.onSelect = (item) => {
      this.onClose();
      onSelect(item);
    };
    this.list.onCancel = () => this.onClose();
  }

  invalidate(): void {
    this.list.invalidate();
  }

  render(width: number): string[] {
    return [fg.cyan(truncate(` ${this.title}`, width)), ...this.list.render(width)];
  }

  handleInput(data: string): void {
    this.list.handleInput(data);
  }
}

/** Command palette overlay (ctrl+p): fuzzy search over the command registry. */
export class PaletteOverlay implements Component, Focusable {
  focused = false;
  private readonly vm = new PaletteViewModel();

  constructor(
    private readonly onExecute: (spec: CommandSpec) => void,
    private readonly onClose: () => void,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const lines = this.vm.renderLines(width, 10);
    return lines.map((line, i) => {
      if (i === 0) return bold(fg.cyan(line));
      if (line.startsWith("❯")) return bold(fg.cyan(line));
      return line;
    });
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+p")) {
      this.onClose();
      return;
    }
    if (matchesKey(data, "up")) {
      this.vm.move(-1);
      return;
    }
    if (matchesKey(data, "down")) {
      this.vm.move(1);
      return;
    }
    if (matchesKey(data, "enter")) {
      const cmd = this.vm.selectedCommand();
      this.onClose();
      if (cmd) this.onExecute(cmd);
      return;
    }
    if (matchesKey(data, "backspace")) {
      this.vm.setQuery(this.vm.query.slice(0, -1));
      return;
    }
    if (data.length === 1 && data >= " ") {
      this.vm.setQuery(this.vm.query + data);
      return;
    }
  }
}
