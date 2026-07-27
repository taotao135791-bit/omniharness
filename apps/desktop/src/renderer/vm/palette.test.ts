import { describe, expect, it } from "vitest";
import { fuzzyScore, moveSelection, rankCommands } from "./palette.js";

describe("fuzzyScore", () => {
  it("rejects non-subsequences", () => {
    expect(fuzzyScore("xyz", "New session").score).toBe(-1);
  });
  it("matches subsequences case-insensitively", () => {
    expect(fuzzyScore("news", "New session").score).toBeGreaterThan(0);
  });
  it("prefers word-boundary consecutive matches", () => {
    const good = fuzzyScore("new", "New session").score;
    const bad = fuzzyScore("new", "Review pending").score;
    expect(good).toBeGreaterThan(bad);
  });
});

describe("rankCommands", () => {
  it("returns all commands for an empty query", () => {
    expect(rankCommands("", true).length).toBeGreaterThan(10);
  });
  it("ranks exact title words first", () => {
    const items = rankCommands("new session", true);
    expect(items[0]!.command.id).toBe("session.new");
  });
  it("matches by command id too", () => {
    const items = rankCommands("diff.accept", true);
    expect(items.some((i) => i.command.id === "diff.acceptAll")).toBe(true);
  });
  it("hides session-required commands without an active session", () => {
    const items = rankCommands("", false);
    expect(items.some((i) => i.command.requiresSession)).toBe(false);
  });
});

describe("moveSelection", () => {
  it("wraps around both ends", () => {
    expect(moveSelection(0, -1, 3)).toBe(2);
    expect(moveSelection(2, 1, 3)).toBe(0);
    expect(moveSelection(1, 1, 3)).toBe(2);
  });
  it("handles empty lists", () => {
    expect(moveSelection(0, 1, 0)).toBe(0);
  });
});
