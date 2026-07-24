import { open, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { IgnoreMatcher, matchesPattern } from "@omniharness/workspace-manager";
import { walkWorkspaceFiles } from "@omniharness/workspace-manager";
import { err, ok } from "../types.js";
import type { Tool, ToolResult } from "../types.js";
import { resolveToolPath } from "./fs.js";

const DEFAULT_HEAD_LIMIT = 100;

async function sniffBinary(abs: string): Promise<boolean> {
  const handle = await open(abs, "r");
  try {
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buffer, 0, 4096, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

export function createGrepTool(): Tool {
  return {
    name: "search.grep",
    description:
      "Regex search over workspace text files. Respects .gitignore / .omniharnessignore, skips binaries, node_modules and .git.",
    parametersSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regular expression" },
        path: { type: "string", description: "Restrict search to this file or directory" },
        glob: { type: "string", description: "Only search files matching this glob" },
        head_limit: { type: "integer", description: `Max matches (default ${DEFAULT_HEAD_LIMIT})` },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    requiredCapabilities: ["fs.read"],
    async execute(args, ctx): Promise<ToolResult> {
      let regex: RegExp;
      try {
        regex = new RegExp(args["pattern"] as string);
      } catch (error) {
        return err(`Invalid regex: ${error instanceof Error ? error.message : String(error)}`);
      }
      const headLimit = (args["head_limit"] as number | undefined) ?? DEFAULT_HEAD_LIMIT;
      const glob = args["glob"] as string | undefined;
      const restrict = args["path"] as string | undefined;

      const matches: string[] = [];
      outer: for (let rootIdx = 0; rootIdx < ctx.workspace.roots.length; rootIdx++) {
        const root = ctx.workspace.roots[rootIdx]!;
        const matcher = await IgnoreMatcher.fromRoot(root);

        let files;
        if (restrict !== undefined) {
          const abs = resolveToolPath(ctx.workspace, restrict);
          const relToRoot = path.relative(root, abs).split(path.sep).join("/");
          const info = await stat(abs).catch(() => null);
          if (info === null) {
            return err(`Path not found: ${restrict}`);
          }
          if (info.isFile()) {
            files = [{ root: rootIdx, rel: relToRoot, abs, size: info.size, mode: info.mode }];
          } else {
            const sub = await walkWorkspaceFiles({
              ...ctx.workspace,
              roots: [abs],
            });
            files = sub.map((f) => ({
              root: rootIdx,
              rel: relToRoot === "" ? f.rel : `${relToRoot}/${f.rel}`,
              abs: f.abs,
              size: f.size,
              mode: f.mode,
            }));
          }
        } else {
          files = await walkWorkspaceFiles({ ...ctx.workspace, roots: [root] });
        }

        for (const file of files) {
          if (restrict === undefined && matcher.isIgnored(file.rel, false)) continue;
          if (glob !== undefined && !matchesPattern(glob, file.rel, false)) continue;
          let text: string;
          try {
            if (await sniffBinary(file.abs)) continue;
            text = await readFile(file.abs, "utf8");
          } catch {
            continue;
          }
          const lines = text.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i]!)) {
              matches.push(`${file.rel}:${i + 1}: ${lines[i]}`);
              if (matches.length >= headLimit) break outer;
            }
          }
        }
      }

      if (matches.length === 0) return ok("No matches.");
      const suffix = matches.length >= headLimit ? `\n[truncated at head_limit ${headLimit}]` : "";
      return ok(matches.join("\n") + suffix);
    },
  };
}

const DEFAULT_GLOB_LIMIT = 1000;

export function createGlobTool(): Tool {
  return {
    name: "search.glob",
    description: "Lists workspace files matching a glob (gitignore-style: *, **, ?).",
    parametersSchema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        head_limit: { type: "integer" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    requiredCapabilities: ["fs.read"],
    async execute(args, ctx): Promise<ToolResult> {
      const pattern = args["pattern"] as string;
      const headLimit = (args["head_limit"] as number | undefined) ?? DEFAULT_GLOB_LIMIT;

      const found: string[] = [];
      for (let rootIdx = 0; rootIdx < ctx.workspace.roots.length; rootIdx++) {
        const root = ctx.workspace.roots[rootIdx]!;
        const files = await walkWorkspaceFiles({ ...ctx.workspace, roots: [root] });
        for (const file of files) {
          if (matchesPattern(pattern, file.rel, false)) {
            found.push(file.rel);
            if (found.length >= headLimit) break;
          }
        }
        if (found.length >= headLimit) break;
      }

      if (found.length === 0) return ok("No matches.");
      found.sort();
      return ok(found.slice(0, headLimit).join("\n"));
    },
  };
}
