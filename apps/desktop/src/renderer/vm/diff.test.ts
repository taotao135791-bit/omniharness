import { describe, expect, it } from "vitest";
import type { DiffFile, DiffResult } from "@omniharness/agent-protocol";
import { fileDecision, hunksOf, parseHunkLines, statusBadge, summarizeDiff } from "./diff.js";

const file: DiffFile = {
  path: "src/a.ts",
  status: "modified",
  additions: 2,
  deletions: 1,
  hunks: [
    {
      index: 0,
      header: "@@ -1,3 +1,4 @@",
      accepted: null,
      lines: [" context", "-old", "+new", "+more", "\\ No newline at end of file"],
    },
    { index: 1, header: "@@ -10,2 +10,2 @@", accepted: null, lines: [" x"] },
  ],
};

describe("parseHunkLines", () => {
  it("classifies add/del/context/meta lines", () => {
    const lines = parseHunkLines(file.hunks[0]!.lines);
    expect(lines.map((l) => l.kind)).toEqual(["context", "del", "add", "add", "meta"]);
    expect(lines[1]!.text).toBe("old");
  });
});

describe("fileDecision", () => {
  it("is pending when nothing is decided", () => {
    expect(fileDecision(file)).toBe("pending");
  });
  it("is partial when some hunks are decided", () => {
    const f: DiffFile = {
      ...file,
      hunks: [
        { ...file.hunks[0]!, accepted: true },
        { ...file.hunks[1]!, accepted: null },
      ],
    };
    expect(fileDecision(f)).toBe("partial");
  });
  it("is accepted/rejected when all hunks agree", () => {
    const f: DiffFile = {
      ...file,
      hunks: [
        { ...file.hunks[0]!, accepted: false },
        { ...file.hunks[1]!, accepted: false },
      ],
    };
    expect(fileDecision(f)).toBe("rejected");
  });
});

describe("summarizeDiff", () => {
  it("counts files, lines and hunk decisions", () => {
    const diff: DiffResult = { files: [file], truncated: false };
    const s = summarizeDiff(diff);
    expect(s.files).toBe(1);
    expect(s.additions).toBe(2);
    expect(s.deletions).toBe(1);
    expect(s.totalHunks).toBe(2);
    expect(s.allDecided).toBe(false);
  });
  it("handles null diff", () => {
    expect(summarizeDiff(null).allDecided).toBe(true);
  });
});

describe("statusBadge / hunksOf", () => {
  it("maps statuses to badges", () => {
    expect(statusBadge("added")).toBe("A");
    expect(statusBadge("renamed")).toBe("R");
  });
  it("parses hunks into renderable views", () => {
    const views = hunksOf(file);
    expect(views).toHaveLength(2);
    expect(views[0]!.lines[2]).toEqual({ kind: "add", text: "new" });
  });
});
