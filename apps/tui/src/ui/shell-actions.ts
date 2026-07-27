import type { SelectItem } from "@earendil-works/pi-tui";

/** Overlay-opening capabilities the shell provides to views. */
export interface ShellActions {
  openInput(title: string, onSubmit: (text: string) => void, initial?: string): void;
  openSelect(title: string, items: SelectItem[], onSelect: (item: SelectItem) => void): void;
}
