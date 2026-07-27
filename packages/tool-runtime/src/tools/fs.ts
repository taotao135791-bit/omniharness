import { open, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Workspace } from "@omniharness/shared-types";
import { assertReadable, assertWritable } from "@omniharness/workspace-manager";
import { err, ok } from "../types.js";
import type { Tool, ToolResult } from "../types.js";

/** Resolves a possibly-relative tool path against the first workspace root. */
export function resolveToolPath(workspace: Workspace, p: string): string {
  if (path.isAbsolute(p)) return p;
  const root = workspace.roots[0];
  if (!root) throw new Error("Workspace has no roots");
  return path.join(root, p);
}

async function isBinaryFile(abs: string): Promise<boolean> {
  const handle = await open(abs, "r");
  try {
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buffer, 0, 4096, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

const MAX_READ_BYTES = 5 * 1024 * 1024;

export function createFsReadTool(): Tool {
  return {
    name: "fs.read",
    description:
      "Reads a text file. Supports 1-based line offset and a line limit. Binary files are detected and not dumped.",
    parametersSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path, absolute or workspace-relative" },
        offset: { type: "integer", description: "1-based line number to start from" },
        limit: { type: "integer", description: "Maximum number of lines to return" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    requiredCapabilities: ["fs.read"],
    async execute(args, ctx): Promise<ToolResult> {
      const p = args["path"] as string;
      let resolved: string;
      try {
        resolved = await assertReadable(ctx.workspace, resolveToolPath(ctx.workspace, p));
      } catch (error) {
        return err(error instanceof Error ? error.message : String(error));
      }

      let handle;
      try {
        handle = await open(resolved, "r");
      } catch (error) {
        return err(`Cannot read ${p}: ${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        const stat = await handle.stat();
        if (stat.isDirectory()) {
          return err(`${p} is a directory; use fs.list instead`);
        }
        if (await isBinaryFile(resolved)) {
          return ok(`Binary file ${p} (${stat.size} bytes); content not displayed.`);
        }
        const size = Math.min(stat.size, MAX_READ_BYTES);
        const buffer = Buffer.alloc(size);
        await handle.read(buffer, 0, size, 0);
        let text = buffer.toString("utf8");
        let truncatedNote = "";
        if (stat.size > MAX_READ_BYTES) {
          truncatedNote = `\n[file truncated at ${MAX_READ_BYTES} bytes of ${stat.size}]`;
        }

        const offset = args["offset"] as number | undefined;
        const limit = args["limit"] as number | undefined;
        if (offset !== undefined || limit !== undefined) {
          const lines = text.split("\n");
          const start = Math.max((offset ?? 1) - 1, 0);
          text = lines.slice(start, limit !== undefined ? start + limit : undefined).join("\n");
        }
        return ok(text + truncatedNote);
      } finally {
        await handle.close();
      }
    },
  };
}

export function createFsWriteTool(): Tool {
  return {
    name: "fs.write",
    description: "Writes a file, creating parent directories as needed.",
    parametersSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    requiredCapabilities: ["fs.write"],
    async execute(args, ctx): Promise<ToolResult> {
      const p = args["path"] as string;
      const content = args["content"] as string;
      let resolved: string;
      try {
        resolved = await assertWritable(ctx.workspace, resolveToolPath(ctx.workspace, p));
      } catch (error) {
        return err(error instanceof Error ? error.message : String(error));
      }
      try {
        await mkdir(path.dirname(resolved), { recursive: true });
        await writeFile(resolved, content, "utf8");
      } catch (error) {
        return err(`Cannot write ${p}: ${error instanceof Error ? error.message : String(error)}`);
      }
      return ok(`Wrote ${Buffer.byteLength(content, "utf8")} bytes to ${p}`);
    },
  };
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let idx = 0;
  for (;;) {
    idx = haystack.indexOf(needle, idx);
    if (idx === -1) return count;
    count++;
    idx += needle.length;
  }
}

export function createFsEditTool(): Tool {
  return {
    name: "fs.edit",
    description:
      "Exact-string replacement in a file. old_string must be unique unless replace_all is true.",
    parametersSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
        replace_all: { type: "boolean", description: "Replace every occurrence" },
      },
      required: ["path", "old_string", "new_string"],
      additionalProperties: false,
    },
    requiredCapabilities: ["fs.write"],
    async execute(args, ctx): Promise<ToolResult> {
      const p = args["path"] as string;
      const oldString = args["old_string"] as string;
      const newString = args["new_string"] as string;
      const replaceAll = args["replace_all"] === true;

      if (oldString === "") {
        return err("old_string must not be empty");
      }
      let resolved: string;
      try {
        resolved = await assertWritable(ctx.workspace, resolveToolPath(ctx.workspace, p));
      } catch (error) {
        return err(error instanceof Error ? error.message : String(error));
      }

      let text: string;
      try {
        text = await readFile(resolved, "utf8");
      } catch (error) {
        return err(`Cannot read ${p}: ${error instanceof Error ? error.message : String(error)}`);
      }

      const occurrences = countOccurrences(text, oldString);
      if (occurrences === 0) {
        return err(`old_string not found in ${p}`);
      }
      if (occurrences > 1 && !replaceAll) {
        return err(
          `old_string occurs ${occurrences} times in ${p}; it must be unique. ` +
            "Provide more context or set replace_all to true.",
        );
      }
      const updated = replaceAll
        ? text.split(oldString).join(newString)
        : text.replace(oldString, newString);
      await writeFile(resolved, updated, "utf8");
      const replaced = replaceAll ? occurrences : 1;
      return ok(`Replaced ${replaced} occurrence${replaced === 1 ? "" : "s"} in ${p}`);
    },
  };
}

export function createFsListTool(): Tool {
  return {
    name: "fs.list",
    description: "Non-recursive directory listing; directories end with a slash.",
    parametersSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path (default: workspace root)" },
      },
      additionalProperties: false,
    },
    requiredCapabilities: ["fs.read"],
    async execute(args, ctx): Promise<ToolResult> {
      const p = (args["path"] as string | undefined) ?? ".";
      let resolved: string;
      try {
        resolved = await assertReadable(ctx.workspace, resolveToolPath(ctx.workspace, p));
      } catch (error) {
        return err(error instanceof Error ? error.message : String(error));
      }
      let entries;
      try {
        entries = await readdir(resolved, { withFileTypes: true });
      } catch (error) {
        return err(`Cannot list ${p}: ${error instanceof Error ? error.message : String(error)}`);
      }
      const lines = entries
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort((a, b) => a.localeCompare(b));
      return ok(lines.join("\n"));
    },
  };
}
