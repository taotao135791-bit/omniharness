import { describe, expect, it } from "vitest";
import { matchGlob, staticBaseDir } from "./glob.js";

describe("matchGlob", () => {
  it.each([
    ["** matches across separators", "/repo/**/*.md", "/repo/a/b/c.md", true],
    ["**/ matches zero segments", "/repo/**/*.md", "/repo/c.md", true],
    ["* stays within a segment", "/repo/*.md", "/repo/a/b.md", false],
    ["* within a segment", "/repo/*.md", "/repo/a.md", true],
    ["? is a single char", "/repo/?.md", "/repo/a.md", true],
    ["? rejects two chars", "/repo/?.md", "/repo/ab.md", false],
    ["trailing **", "/repo/**", "/repo/any/thing.txt", true],
    ["literal dots are escaped", "/repo/*.md", "/repo/aXmd", false],
    ["segment prefix", "/repo/src/*.ts", "/repo/src/x.ts", true],
    ["no partial match", "/repo/*.md", "/repo/a.md.bak", false],
  ])("%s", (_label, glob, path, expected) => {
    expect(matchGlob(glob, path)).toBe(expected);
  });
});

describe("staticBaseDir", () => {
  it.each([
    ["/repo/docs/**/*.md", "/repo/docs"],
    ["/repo/*.md", "/repo"],
    ["/repo/docs", "/repo/docs"],
    ["*.md", "."],
    ["**/*.md", "."],
    ["/*.md", "/"],
  ])("%s → %s", (glob, expected) => {
    expect(staticBaseDir(glob)).toBe(expected);
  });
});
