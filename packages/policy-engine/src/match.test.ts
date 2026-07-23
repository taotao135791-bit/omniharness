import { describe, expect, it } from "vitest";
import { globToRegExp } from "./glob.js";
import {
  constraintsMatch,
  matchCommandPatterns,
  matchDomain,
  matchPathGlobs,
} from "./match.js";

describe("globToRegExp", () => {
  it("matches `*` within a single segment only", () => {
    const re = globToRegExp("*.ts");
    expect(re.test("index.ts")).toBe(true);
    expect(re.test("src/index.ts")).toBe(false);
    expect(re.test("index.js")).toBe(false);
  });

  it("matches `**` across path segments, including zero segments", () => {
    const re = globToRegExp("src/**/*.ts");
    expect(re.test("src/a/b/c.ts")).toBe(true);
    expect(re.test("src/index.ts")).toBe(true);
    expect(re.test("lib/index.ts")).toBe(false);
  });

  it("matches trailing `**`", () => {
    const re = globToRegExp("/work/repo/**");
    expect(re.test("/work/repo/a/b.txt")).toBe(true);
    expect(re.test("/work/repo")).toBe(false);
  });

  it("matches `?` as a single character within a segment", () => {
    const re = globToRegExp("file?.txt");
    expect(re.test("file1.txt")).toBe(true);
    expect(re.test("file12.txt")).toBe(false);
    expect(re.test("file/txt")).toBe(false);
  });

  it("escapes regex metacharacters", () => {
    const re = globToRegExp("a+b.(ts)");
    expect(re.test("a+b.(ts)")).toBe(true);
    expect(re.test("aaab.(ts)")).toBe(false);
  });

  it("anchors the full string", () => {
    const re = globToRegExp("foo");
    expect(re.test("foo")).toBe(true);
    expect(re.test("foobar")).toBe(false);
    expect(re.test("barfoo")).toBe(false);
  });
});

describe("matchPathGlobs", () => {
  it("matches when any glob matches", () => {
    expect(matchPathGlobs(["/etc/**", "/work/**"], "/work/repo/a.ts")).toBe(true);
    expect(matchPathGlobs(["/etc/**"], "/work/repo/a.ts")).toBe(false);
  });
});

describe("matchDomain", () => {
  it("suffix-matches subdomains", () => {
    expect(matchDomain(["example.com"], "example.com")).toBe(true);
    expect(matchDomain(["example.com"], "sub.example.com")).toBe(true);
    expect(matchDomain(["example.com"], "deep.sub.example.com")).toBe(true);
  });

  it("rejects partial-suffix lookalikes", () => {
    expect(matchDomain(["example.com"], "notexample.com")).toBe(false);
    expect(matchDomain(["example.com"], "example.com.evil.io")).toBe(false);
    expect(matchDomain(["example.com"], "com")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(matchDomain(["Example.COM"], "sub.example.com")).toBe(true);
  });
});

describe("matchCommandPatterns", () => {
  it("treats patterns as globs over the whole command", () => {
    expect(matchCommandPatterns(["git *"], "git status")).toBe(true);
    expect(matchCommandPatterns(["git *"], "git push origin main")).toBe(true);
    expect(matchCommandPatterns(["git *"], "npm test")).toBe(false);
  });

  it("supports `**` to cross path separators", () => {
    expect(matchCommandPatterns(["rm **"], "rm -rf /tmp/x")).toBe(true);
    expect(matchCommandPatterns(["rm *"], "rm -rf /tmp/x")).toBe(false);
  });
});

describe("constraintsMatch", () => {
  it("matches when no constraints are present", () => {
    expect(constraintsMatch(undefined, "fs.read", undefined)).toBe(true);
    expect(constraintsMatch({}, "fs.read", undefined)).toBe(true);
  });

  it("does not match a filtering constraint when target is undefined", () => {
    expect(constraintsMatch({ pathGlobs: ["/work/**"] }, "fs.read", undefined)).toBe(false);
    expect(constraintsMatch({ domains: ["example.com"] }, "network", undefined)).toBe(false);
  });

  it("requires all present dimensions to match", () => {
    const constraints = {
      pathGlobs: ["/work/**"],
      commandPatterns: ["cat *"],
    };
    expect(constraintsMatch(constraints, "fs.read", "/work/a.ts")).toBe(false); // command dim fails
    expect(constraintsMatch({ pathGlobs: ["/work/**"] }, "fs.read", "/work/a.ts")).toBe(true);
    expect(constraintsMatch({ pathGlobs: ["/work/**"] }, "fs.read", "/etc/passwd")).toBe(false);
  });

  it("treats maxFileSizeBytes as a non-filtering constraint", () => {
    expect(constraintsMatch({ maxFileSizeBytes: 1024 }, "fs.write", undefined)).toBe(true);
    expect(constraintsMatch({ maxFileSizeBytes: 1024 }, "fs.write", "/any/path")).toBe(true);
  });
});
