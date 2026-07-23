import { git } from "./exec.js";

export type DiffFileStatus = "added" | "modified" | "deleted" | "renamed";

export interface DiffHunk {
  /** Zero-based position of the hunk within the file's diff. */
  index: number;
  /** The `@@ ... @@` header line. */
  header: string;
  /** Raw hunk body lines (context, +, - and "\ No newline" markers). */
  lines: string[];
}

export interface DiffFile {
  /** New path (repo-relative). For deletions this is the removed path. */
  path: string;
  /** Previous path, set only for renames. */
  oldPath?: string;
  status: DiffFileStatus;
  /** Binary files carry no hunks. */
  binary: boolean;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
  /** Raw `diff --git` ... pre-hunk header lines, kept for patch reconstruction. */
  headerLines: string[];
}

export interface DiffOptions {
  /** Diff the index against HEAD instead of the working tree. */
  staged?: boolean;
  /** Diff against this ref instead of HEAD/index. */
  base?: string;
}

/** Runs `git diff` and parses the unified output into structured files. */
export async function diff(path: string, opts?: DiffOptions): Promise<DiffFile[]> {
  const args = ["diff", "--no-color", "--no-ext-diff"];
  if (opts?.staged) args.push("--cached");
  if (opts?.base) args.push(opts.base);
  args.push("--");
  const out = await git(args, { cwd: path });
  return parseUnifiedDiff(out);
}

/** Parses unified diff text into {@link DiffFile} records. */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const lines = text.split("\n");
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let currentHunk: DiffHunk | null = null;
  let pendingRenameFrom: string | undefined;

  const flush = (): void => {
    if (currentHunk) {
      while (currentHunk.lines.length > 0 && currentHunk.lines[currentHunk.lines.length - 1] === "") {
        currentHunk.lines.pop();
      }
    }
    if (current) files.push(current);
    current = null;
    currentHunk = null;
    pendingRenameFrom = undefined;
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flush();
      const [a, b] = parseDiffGitPaths(line.slice("diff --git ".length));
      current = {
        path: b ?? a ?? "",
        binary: false,
        status: "modified",
        hunks: [],
        additions: 0,
        deletions: 0,
        headerLines: [line],
      };
      continue;
    }
    if (!current) continue;

    if (line.startsWith("@@")) {
      currentHunk = { index: current.hunks.length, header: line, lines: [] };
      current.hunks.push(currentHunk);
      continue;
    }
    if (currentHunk) {
      currentHunk.lines.push(line);
      if (line.startsWith("+")) current.additions++;
      else if (line.startsWith("-")) current.deletions++;
      continue;
    }

    // Still in the file header region.
    current.headerLines.push(line);
    if (line.startsWith("new file mode")) {
      current.status = "added";
    } else if (line.startsWith("deleted file mode")) {
      current.status = "deleted";
    } else if (line.startsWith("rename from ")) {
      current.status = "renamed";
      pendingRenameFrom = line.slice("rename from ".length);
      current.oldPath = pendingRenameFrom;
    } else if (line.startsWith("rename to ")) {
      current.status = "renamed";
      current.path = line.slice("rename to ".length);
    } else if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      current.binary = true;
    } else if (line.startsWith("--- ")) {
      const p = stripDiffPrefix(line.slice(4));
      if (p !== null && current.status === "deleted") current.path = p;
    } else if (line.startsWith("+++ ")) {
      const p = stripDiffPrefix(line.slice(4));
      if (p !== null) current.path = p;
    }
  }
  flush();

  // A pure rename may leave headerLines with a trailing "" from the final split.
  for (const f of files) {
    while (f.headerLines.length > 0 && f.headerLines[f.headerLines.length - 1] === "") {
      f.headerLines.pop();
    }
  }
  return files;
}

/** Strips the `a/` or `b/` prefix; returns null for `/dev/null`. Unquotes C-style paths. */
function stripDiffPrefix(raw: string): string | null {
  if (raw === "/dev/null") return null;
  const unquoted = raw.startsWith('"') ? unquoteCStyle(raw) : raw;
  if (unquoted.startsWith("a/") || unquoted.startsWith("b/")) {
    return unquoted.slice(2);
  }
  return unquoted;
}

/**
 * Splits the `a/<path> b/<path>` tail of a `diff --git` line. Git does not
 * quote paths containing only spaces, so we split at the first " b/".
 */
function parseDiffGitPaths(tail: string): [string | null, string | null] {
  if (tail.startsWith('"')) {
    // Both sides quoted: parse two consecutive quoted strings.
    const first = readQuoted(tail, 0);
    if (first) {
      const [a, end] = first;
      const rest = tail.slice(end).trimStart();
      const second = readQuoted(rest, 0);
      return [stripDiffPrefix(a), second ? stripDiffPrefix(second[0]) : null];
    }
  }
  const idx = tail.indexOf(" b/");
  if (idx === -1) {
    const p = stripDiffPrefix(tail);
    return [p, p];
  }
  return [stripDiffPrefix(tail.slice(0, idx)), stripDiffPrefix(tail.slice(idx + 1))];
}

function readQuoted(s: string, start: number): [string, number] | null {
  if (s[start] !== '"') return null;
  let i = start + 1;
  let escaped = false;
  while (i < s.length) {
    const ch = s[i];
    if (escaped) {
      escaped = false;
    } else if (ch === "\\") {
      escaped = true;
    } else if (ch === '"') {
      return [s.slice(start, i + 1), i + 1];
    }
    i++;
  }
  return null;
}

function unquoteCStyle(quoted: string): string {
  if (!quoted.startsWith('"') || !quoted.endsWith('"')) return quoted;
  const body = quoted.slice(1, -1);
  return body.replace(/\\(\\\\)?(.)/gs, (_m, _bs, ch: string) => {
    switch (ch) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case "\\":
        return "\\";
      case '"':
        return '"';
      default:
        return ch;
    }
  });
}

export interface ApplyHunksOptions {
  /** Apply the selected hunks in reverse (reject previously applied changes). */
  reverse?: boolean;
  /** Apply to the index instead of the working tree. */
  cached?: boolean;
}

/**
 * Reconstructs a valid patch from a parsed diff file containing only the
 * selected hunks and pipes it to `git apply`. Hunk headers and bodies are
 * preserved verbatim, so line counts stay consistent.
 */
export async function applyHunks(
  path: string,
  file: DiffFile,
  hunkIndexes: readonly number[],
  opts?: ApplyHunksOptions,
): Promise<void> {
  if (file.binary) {
    throw new Error(`Cannot apply hunks of binary file ${file.path}`);
  }
  if (hunkIndexes.length === 0) {
    throw new Error("No hunks selected");
  }
  const selected = [...hunkIndexes].sort((a, b) => a - b).map((i) => {
    const hunk = file.hunks[i];
    if (!hunk) {
      throw new Error(`Hunk index ${i} out of range for ${file.path} (${file.hunks.length} hunks)`);
    }
    return hunk;
  });

  const patchLines: string[] = [...file.headerLines];
  for (const hunk of selected) {
    patchLines.push(hunk.header, ...hunk.lines);
  }
  // Drop trailing blank lines introduced by splitting on "\n", then terminate.
  while (patchLines.length > 0 && patchLines[patchLines.length - 1] === "") {
    patchLines.pop();
  }
  const patch = patchLines.join("\n") + "\n";

  const args = ["apply", "--whitespace=nowarn"];
  if (opts?.reverse) args.push("-R");
  if (opts?.cached) args.push("--cached");
  await git(args, { cwd: path, input: patch });
}
