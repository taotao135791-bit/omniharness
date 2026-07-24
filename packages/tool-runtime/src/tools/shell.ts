import { LocalShellExecutor } from "../shell.js";
import type { SandboxExecutor } from "../shell.js";
import { ok } from "../types.js";
import type { Tool, ToolResult } from "../types.js";
import { resolveToolPath } from "./fs.js";

const DEFAULT_TIMEOUT_MS = 30_000;

export function createShellExecTool(executor?: SandboxExecutor): Tool {
  const exec = executor ?? new LocalShellExecutor();
  return {
    name: "shell.exec",
    description:
      "Executes a command (no shell interpolation: command + argv array) and streams output.",
    parametersSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        args: { type: "array", items: { type: "string" } },
        cwd: { type: "string", description: "Working directory (default: workspace root)" },
        timeout_ms: { type: "integer", description: `Timeout (default ${DEFAULT_TIMEOUT_MS})` },
      },
      required: ["command"],
      additionalProperties: false,
    },
    requiredCapabilities: ["shell.exec"],
    async execute(toolArgs, ctx): Promise<ToolResult> {
      const command = toolArgs["command"] as string;
      const argv = (toolArgs["args"] as string[] | undefined) ?? [];
      const cwd =
        toolArgs["cwd"] !== undefined
          ? resolveToolPath(ctx.workspace, toolArgs["cwd"] as string)
          : (ctx.workspace.roots[0] ?? process.cwd());
      const timeoutMs = (toolArgs["timeout_ms"] as number | undefined) ?? DEFAULT_TIMEOUT_MS;

      let result;
      try {
        result = await exec.exec({
          command,
          args: argv,
          cwd,
          timeoutMs,
          signal: ctx.signal,
          onChunk: (chunk) => ctx.emit(chunk),
        });
      } catch (error) {
        return {
          ok: false,
          isError: true,
          output: `Failed to start ${command}: ${error instanceof Error ? error.message : String(error)}`,
        };
      }

      const parts: string[] = [];
      if (result.stdout !== "") parts.push(result.stdout.trimEnd());
      if (result.stderr !== "") parts.push(`[stderr]\n${result.stderr.trimEnd()}`);
      if (result.timedOut) parts.push(`[timed out after ${result.durationMs} ms]`);
      if (result.exitCode !== 0) parts.push(`[exit code ${result.exitCode}]`);
      const output = parts.join("\n");

      if (result.timedOut || result.exitCode !== 0) {
        return { ok: false, isError: true, output: output === "" ? `[exit code ${result.exitCode}]` : output };
      }
      return ok(output);
    },
  };
}
