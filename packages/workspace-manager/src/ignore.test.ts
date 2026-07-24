import { describe, expect, it } from "vitest";
import { IgnoreMatcher, matchesPattern, parseGitignore } from "./index.js";

describe("gitignore matcher", () => {
  it("matches * without crossing directories", () => {
    expect(matchesPattern("*.log", "error.log", false)).toBe(true);
    expect(matchesPattern("*.log", "logs/error.log", false)).toBe(true); // basename match
    expect(matchesPattern("logs/*.log", "logs/error.log", false)).toBe(true);
    expect(matchesPattern("logs/*.log", "logs/deep/error.log", false)).toBe(false);
  });

  it("matches ** across directories", () => {
    expect(matchesPattern("**/secret.txt", "a/b/secret.txt", false)).toBe(true);
    expect(matchesPattern("docs/**", "docs/a/b/c.md", false)).toBe(true);
    expect(matchesPattern("docs/**", "docs/readme.md", false)).toBe(true);
    expect(matchesPattern("a/**/b.txt", "a/x/y/b.txt", false)).toBe(true);
  });

  it("matches ? as a single non-slash character", () => {
    expect(matchesPattern("file?.txt", "file1.txt", false)).toBe(true);
    expect(matchesPattern("file?.txt", "file/1.txt", false)).toBe(false);
  });

  it("anchors patterns with a leading or inner slash", () => {
    expect(matchesPattern("/build", "build", true)).toBe(true);
    expect(matchesPattern("/build", "sub/build", true)).toBe(false);
    expect(matchesPattern("build", "sub/build", true)).toBe(true);
  });

  it("applies dir-only patterns to directories and their contents", () => {
    const m = IgnoreMatcher.fromContent("dist/\n");
    expect(m.isIgnored("dist", true)).toBe(true);
    expect(m.isIgnored("dist", false)).toBe(false);
    expect(m.isIgnored("dist/out.js", false)).toBe(true);
  });

  it("honors negation with last-match-wins", () => {
    const m = IgnoreMatcher.fromContent("*.log\n!important.log\n");
    expect(m.isIgnored("error.log", false)).toBe(true);
    expect(m.isIgnored("important.log", false)).toBe(false);

    const m2 = IgnoreMatcher.fromContent("important.log\n*.log\n");
    expect(m2.isIgnored("important.log", false)).toBe(true);
  });

  it("skips comments and blank lines", () => {
    expect(parseGitignore("# comment\n\n*.tmp\n")).toHaveLength(1);
  });
});
