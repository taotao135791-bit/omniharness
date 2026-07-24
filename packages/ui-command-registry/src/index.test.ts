import { describe, expect, it } from "vitest";
import { COMMANDS, byKeybinding, searchCommands } from "./index.js";

describe("ui-command-registry", () => {
  it("has unique ids", () => {
    const ids = COMMANDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("searches by title and id", () => {
    expect(searchCommands("diff").length).toBeGreaterThan(0);
    expect(searchCommands("session.rename")[0]?.id).toBe("session.rename");
    expect(searchCommands("").length).toBe(COMMANDS.length);
  });

  it("looks up keybindings", () => {
    expect(byKeybinding("ctrl+p")?.id).toBe("view.palette");
  });
});
