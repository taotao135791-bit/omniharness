import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Workspace } from "@omniharness/shared-types";
import {
  createFsEditTool,
  createFsListTool,
  createFsReadTool,
  createFsWriteTool,
  createGlobTool,
  createGrepTool,
} from "./index.js";
import type { ToolContext, ToolResult } from "./index.js";

/** tool.execute may also return a stream; these tools always resolve to ToolResult. */
async function asResult(value: unknown): Promise<ToolResult> {
  const v = await value;
  if (typeof v === "object" && v !== null && "ok" in v) return v as ToolResult;
  throw new Error("expected ToolResult, got stream");
}

let dir: string;
let workspace: Workspace;
let ctx: ToolContext;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "omniharness-tools-"));
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src", "a.ts"), "line1\nline2\nline3\nline4\n");
  await writeFile(join(dir, "README.md"), "# hello\nworld hello\n");
  workspace = {
    id: "ws_t" as Workspace["id"],
    projectId: "prj_t" as Workspace["projectId"],
    name: "t",
    kind: "folder",
    roots: [dir],
    protectedPaths: [],
    readOnlyPaths: [],
    createdAt: new Date().toISOString(),
  };
  ctx = {
    workspace,
    sessionId: "s",
    agentId: "a",
    signal: new AbortController().signal,
    emit: () => undefined,
  };
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("fs.read", () => {
  it("reads a whole file", async () => {
    const res = await asResult(createFsReadTool().execute({ path: "src/a.ts" }, ctx));
    expect(res.ok).toBe(true);
    expect(res.output).toBe("line1\nline2\nline3\nline4\n");
  });

  it("honors offset and limit", async () => {
    const res = await asResult(createFsReadTool().execute({ path: "src/a.ts", offset: 2, limit: 2 }, ctx));
    expect(res.output).toBe("line2\nline3");
  });

  it("detects binary files", async () => {
    await writeFile(join(dir, "bin.dat"), Buffer.from([65, 0, 66]));
    const res = await asResult(createFsReadTool().execute({ path: "bin.dat" }, ctx));
    expect(res.ok).toBe(true);
    expect(res.output).toContain("Binary file");
  });

  it("errors on missing files and directories", async () => {
    expect((await asResult(createFsReadTool().execute({ path: "nope.txt" }, ctx))).isError).toBe(true);
    const res = await asResult(createFsReadTool().execute({ path: "src" }, ctx));
    expect(res.isError).toBe(true);
    expect(res.output).toContain("directory");
  });
});

describe("fs.write", () => {
  it("creates parent directories", async () => {
    const res = await asResult(createFsWriteTool().execute(
      { path: "deep/nested/new.txt", content: "fresh" },
      ctx,
    ));
    expect(res.ok).toBe(true);
    expect(await readFile(join(dir, "deep", "nested", "new.txt"), "utf8")).toBe("fresh");
  });

  it("blocks writes escaping the workspace through a symlink", async () => {
    const outside = await mkdtemp(join(tmpdir(), "omniharness-out-"));
    await symlink(outside, join(dir, "escape"), "dir");
    const res = await asResult(createFsWriteTool().execute(
      { path: "escape/pwned.txt", content: "x" },
      ctx,
    ));
    expect(res.ok).toBe(false);
    expect(res.output).toContain("outside the workspace");
    await rm(outside, { recursive: true, force: true });
  });

  it("blocks writes to read-only paths", async () => {
    workspace.readOnlyPaths = ["src/**"];
    const res = await asResult(createFsWriteTool().execute({ path: "src/b.ts", content: "x" }, ctx));
    expect(res.ok).toBe(false);
    expect(res.output).toContain("read-only");
  });
});

describe("fs.edit", () => {
  it("replaces a unique string", async () => {
    const res = await asResult(createFsEditTool().execute(
      { path: "src/a.ts", old_string: "line2", new_string: "LINE2" },
      ctx,
    ));
    expect(res.ok).toBe(true);
    expect(await readFile(join(dir, "src", "a.ts"), "utf8")).toContain("LINE2");
  });

  it("refuses ambiguous replacements without replace_all", async () => {
    const res = await asResult(createFsEditTool().execute(
      { path: "src/a.ts", old_string: "line", new_string: "row" },
      ctx,
    ));
    expect(res.ok).toBe(false);
    expect(res.output).toContain("4 times");
  });

  it("replace_all replaces every occurrence", async () => {
    const res = await asResult(createFsEditTool().execute(
      { path: "src/a.ts", old_string: "line", new_string: "row", replace_all: true },
      ctx,
    ));
    expect(res.ok).toBe(true);
    expect(res.output).toContain("4 occurrences");
    expect(await readFile(join(dir, "src", "a.ts"), "utf8")).toBe("row1\nrow2\nrow3\nrow4\n");
  });

  it("errors when old_string is not found", async () => {
    const res = await asResult(createFsEditTool().execute(
      { path: "src/a.ts", old_string: "zzz", new_string: "x" },
      ctx,
    ));
    expect(res.ok).toBe(false);
    expect(res.output).toContain("not found");
  });
});

describe("fs.list", () => {
  it("lists entries with directory markers", async () => {
    const res = await asResult(createFsListTool().execute({}, ctx));
    expect(res.ok).toBe(true);
    expect(res.output.split("\n")).toEqual(["README.md", "src/"]);
  });

  it("errors on missing directory", async () => {
    expect((await asResult(createFsListTool().execute({ path: "nope" }, ctx))).isError).toBe(true);
  });
});

describe("search.grep", () => {
  it("finds matches with path and line numbers", async () => {
    const res = await asResult(createGrepTool().execute({ pattern: "hello" }, ctx));
    expect(res.ok).toBe(true);
    expect(res.output).toContain("README.md:1: # hello");
    expect(res.output).toContain("README.md:2: world hello");
  });

  it("respects .gitignore and skips node_modules", async () => {
    await mkdir(join(dir, "node_modules", "dep"), { recursive: true });
    await writeFile(join(dir, "node_modules", "dep", "x.js"), "hello\n");
    await mkdir(join(dir, "build"), { recursive: true });
    await writeFile(join(dir, "build", "out.js"), "hello\n");
    await writeFile(join(dir, ".gitignore"), "build/\n");

    const res = await asResult(createGrepTool().execute({ pattern: "hello" }, ctx));
    expect(res.output).not.toContain("node_modules");
    expect(res.output).not.toContain("build/out.js");
    expect(res.output).toContain("README.md");
  });

  it("supports glob filter, path restriction and head limit", async () => {
    const byGlob = await asResult(createGrepTool().execute({ pattern: "line", glob: "*.ts" }, ctx));
    expect(byGlob.output).toContain("src/a.ts");

    const restricted = await asResult(createGrepTool().execute({ pattern: "hello", path: "README.md" }, ctx));
    expect(restricted.output).not.toContain("a.ts");

    const limited = await asResult(createGrepTool().execute({ pattern: "line", head_limit: 2 }, ctx));
    expect(limited.output.split("\n").filter((l) => l.includes(": "))).toHaveLength(2);
    expect(limited.output).toContain("truncated");
  });

  it("rejects invalid regex", async () => {
    const res = await asResult(createGrepTool().execute({ pattern: "([" }, ctx));
    expect(res.isError).toBe(true);
  });
});

describe("search.glob", () => {
  it("matches files by glob", async () => {
    const res = await asResult(createGlobTool().execute({ pattern: "**/*.ts" }, ctx));
    expect(res.output).toBe("src/a.ts");
  });

  it("matches basename patterns at any depth", async () => {
    const res = await asResult(createGlobTool().execute({ pattern: "*.md" }, ctx));
    expect(res.output).toBe("README.md");
  });

  it("reports no matches", async () => {
    expect((await asResult(createGlobTool().execute({ pattern: "*.py" }, ctx))).output).toBe("No matches.");
  });
});
