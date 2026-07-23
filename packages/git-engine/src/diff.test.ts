import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyHunks, diff, init, parseUnifiedDiff } from "./index.js";
import { git } from "./exec.js";

let dir: string;

async function commitAll(repo: string, message: string): Promise<void> {
  await git(["add", "-A"], { cwd: repo });
  await git(
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", message],
    { cwd: repo },
  );
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "omniharness-diff-"));
  await init(dir, { initialBranch: "main" });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("diff parsing", () => {
  it("parses modified files with hunks and counts", async () => {
    await writeFile(join(dir, "a.txt"), "one\ntwo\nthree\n");
    await commitAll(dir, "base");
    await writeFile(join(dir, "a.txt"), "one\nTWO\nthree\nfour\n");

    const files = await diff(dir);
    expect(files).toHaveLength(1);
    const f = files[0]!;
    expect(f.path).toBe("a.txt");
    expect(f.status).toBe("modified");
    expect(f.binary).toBe(false);
    expect(f.hunks).toHaveLength(1);
    expect(f.additions).toBe(2);
    expect(f.deletions).toBe(1);
  });

  it("classifies added, deleted and renamed files", async () => {
    await writeFile(join(dir, "old.txt"), "same content line\n");
    await writeFile(join(dir, "gone.txt"), "bye\n");
    await commitAll(dir, "base");
    await git(["mv", "old.txt", "new.txt"], { cwd: dir });
    await rm(join(dir, "gone.txt"));
    await writeFile(join(dir, "added.txt"), "new\n");

    const files = await diff(dir);
    const byPath = new Map(files.map((f) => [f.path, f]));
    expect(byPath.get("added.txt")?.status).toBe("added");
    expect(byPath.get("gone.txt")?.status).toBe("deleted");
    const renamed = byPath.get("new.txt");
    expect(renamed?.status).toBe("renamed");
    expect(renamed?.oldPath).toBe("old.txt");
  });

  it("marks binary files and skips hunks", async () => {
    await writeFile(join(dir, "bin.dat"), Buffer.from([0, 1, 2, 3, 4]));
    await commitAll(dir, "base");
    await writeFile(join(dir, "bin.dat"), Buffer.from([0, 9, 9, 9, 4]));

    const files = await diff(dir);
    expect(files).toHaveLength(1);
    expect(files[0]!.binary).toBe(true);
    expect(files[0]!.hunks).toEqual([]);
    expect(files[0]!.path).toBe("bin.dat");
  });

  it("handles filenames with spaces", async () => {
    await writeFile(join(dir, "my file.txt"), "a\nb\n");
    await commitAll(dir, "base");
    await writeFile(join(dir, "my file.txt"), "a\nB\n");

    const files = await diff(dir);
    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe("my file.txt");
    expect(files[0]!.additions).toBe(1);
    expect(files[0]!.deletions).toBe(1);
  });

  it("supports staged and base diffs", async () => {
    await writeFile(join(dir, "a.txt"), "1\n");
    await commitAll(dir, "base");
    await writeFile(join(dir, "a.txt"), "2\n");

    expect(await diff(dir, { staged: true })).toEqual([]);
    await git(["add", "a.txt"], { cwd: dir });
    const staged = await diff(dir, { staged: true });
    expect(staged).toHaveLength(1);

    await commitAll(dir, "second");
    await writeFile(join(dir, "a.txt"), "3\n");
    const againstBase = await diff(dir, { base: "HEAD~1" });
    expect(againstBase[0]!.additions).toBe(1);
    expect(againstBase[0]!.deletions).toBe(1);
  });

  it("parseUnifiedDiff parses standalone diff text", () => {
    const text = [
      "diff --git a/x.txt b/x.txt",
      "index 1111111..2222222 100644",
      "--- a/x.txt",
      "+++ b/x.txt",
      "@@ -1,2 +1,2 @@",
      " ctx",
      "-old",
      "+new",
      "",
    ].join("\n");
    const files = parseUnifiedDiff(text);
    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe("x.txt");
    expect(files[0]!.hunks[0]!.lines).toEqual([" ctx", "-old", "+new"]);
  });
});

describe("applyHunks", () => {
  it("applies only the selected hunk", async () => {
    const original = Array.from({ length: 30 }, (_, i) => `line${i + 1}`).join("\n") + "\n";
    await writeFile(join(dir, "big.txt"), original);
    await commitAll(dir, "base");

    const lines = original.split("\n");
    lines[1] = "CHANGED-2";
    lines[20] = "CHANGED-21";
    await writeFile(join(dir, "big.txt"), lines.join("\n"));

    const files = await diff(dir);
    const f = files[0]!;
    expect(f.hunks.length).toBe(2);

    // Reset the file to the committed state, then re-apply only hunk 0.
    await git(["checkout", "--", "big.txt"], { cwd: dir });
    await applyHunks(dir, f, [0]);
    const content = await readFile(join(dir, "big.txt"), "utf8");
    expect(content).toContain("CHANGED-2");
    expect(content).toContain("line21");
    expect(content).not.toContain("CHANGED-21");
  });

  it("reverse-applies a hunk to reject a change already in the working tree", async () => {
    await writeFile(join(dir, "a.txt"), "alpha\nbeta\ngamma\n");
    await commitAll(dir, "base");
    await writeFile(join(dir, "a.txt"), "alpha\nBETA\ngamma\n");

    const files = await diff(dir);
    const f = files[0]!;

    // Reject: reverse-apply the only hunk → file returns to committed state.
    await applyHunks(dir, f, [0], { reverse: true });
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("alpha\nbeta\ngamma\n");
  });

  it("applies hunks for a file whose name contains spaces", async () => {
    await writeFile(join(dir, "sp ace.txt"), "x\ny\n");
    await commitAll(dir, "base");
    await writeFile(join(dir, "sp ace.txt"), "x\nY\n");

    const files = await diff(dir);
    const f = files[0]!;
    expect(f.path).toBe("sp ace.txt");
    await applyHunks(dir, f, [0], { reverse: true });
    expect(await readFile(join(dir, "sp ace.txt"), "utf8")).toBe("x\ny\n");
  });

  it("rejects out-of-range hunk indexes and binary files", async () => {
    await writeFile(join(dir, "a.txt"), "1\n");
    await commitAll(dir, "base");
    await writeFile(join(dir, "a.txt"), "2\n");
    const f = (await diff(dir))[0]!;
    await expect(applyHunks(dir, f, [7])).rejects.toThrow(/out of range/);
    await expect(applyHunks(dir, f, [])).rejects.toThrow(/No hunks/);
    await expect(applyHunks(dir, { ...f, binary: true }, [0])).rejects.toThrow(/binary/);
  });
});
