import { describe, expect, it } from "vitest";
import { COMMANDS } from "@omniharness/ui-command-registry";
import { PaletteViewModel } from "./vm/palette-vm.js";

describe("command palette", () => {
  it("empty query lists every command", () => {
    const vm = new PaletteViewModel();
    expect(vm.matches).toHaveLength(COMMANDS.length);
  });

  it("fuzzy-searches the registry", () => {
    const vm = new PaletteViewModel();
    vm.setQuery("diff");
    const ids = vm.matches.map((c) => c.id);
    expect(ids).toContain("diff.review");
    expect(ids).toContain("diff.acceptAll");
    expect(ids).not.toContain("session.new");

    vm.setQuery("palette");
    expect(vm.matches.map((c) => c.id)).toEqual(["view.palette"]);
  });

  it("selection moves and wraps", () => {
    const vm = new PaletteViewModel();
    vm.setQuery("diff");
    expect(vm.selected).toBe(0);
    vm.move(-1);
    expect(vm.selected).toBe(vm.matches.length - 1);
    vm.move(1);
    expect(vm.selected).toBe(0);
    expect(vm.selectedCommand()?.id).toBe(vm.matches[0]?.id);
  });

  it("keeps selection in range when the filter shrinks", () => {
    const vm = new PaletteViewModel();
    vm.move(5);
    vm.setQuery("view.palette");
    expect(vm.selected).toBe(0);
  });

  it("renders the query line and matches", () => {
    const vm = new PaletteViewModel();
    vm.setQuery("sess");
    const lines = vm.renderLines(60, 10);
    expect(lines[0]).toBe("> sess");
    expect(lines.some((l) => l.startsWith("❯"))).toBe(true);
  });
});
