import type { Capability } from "@omniharness/shared-types";
import type { Tool } from "./types.js";

export class DuplicateToolError extends Error {
  constructor(name: string) {
    super(`A tool named "${name}" is already registered`);
    this.name = "DuplicateToolError";
  }
}

export interface ToolSummary {
  name: string;
  description: string;
  requiredCapabilities: Capability[];
}

/** Registry of available tools; backs the tool.list command. */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new DuplicateToolError(tool.name);
    }
    this.tools.set(tool.name, tool);
  }

  registerAll(tools: readonly Tool[]): void {
    for (const tool of tools) this.register(tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  list(): ToolSummary[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      requiredCapabilities: [...t.requiredCapabilities],
    }));
  }
}
