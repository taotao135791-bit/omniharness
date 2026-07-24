import type { SandboxExecutor } from "../shell.js";
import type { Tool } from "../types.js";
import { createFsEditTool, createFsListTool, createFsReadTool, createFsWriteTool } from "./fs.js";
import { createGlobTool, createGrepTool } from "./search.js";
import { createShellExecTool } from "./shell.js";

export interface CoreToolsDeps {
  /** Defaults to LocalShellExecutor. */
  sandbox?: SandboxExecutor;
}

/** The seven built-in tools. */
export function createCoreTools(deps?: CoreToolsDeps): Tool[] {
  return [
    createFsReadTool(),
    createFsWriteTool(),
    createFsEditTool(),
    createFsListTool(),
    createGrepTool(),
    createGlobTool(),
    createShellExecTool(deps?.sandbox),
  ];
}

export { createFsReadTool, createFsWriteTool, createFsEditTool, createFsListTool } from "./fs.js";
export { createGrepTool, createGlobTool } from "./search.js";
export { createShellExecTool } from "./shell.js";
