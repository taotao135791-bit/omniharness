import type { Artifact, Capability, Workspace } from "@omniharness/shared-types";

/** JSON Schema subset understood by the runtime validator. */
export interface JsonSchema {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  properties?: Record<string, JsonSchema>;
  required?: readonly string[];
  items?: JsonSchema;
  enum?: readonly unknown[];
  additionalProperties?: boolean | JsonSchema;
  description?: string;
}

export type ToolOutputStream = "stdout" | "stderr" | "info";

export interface ToolOutputChunk {
  stream: ToolOutputStream;
  text: string;
}

export interface ToolResult {
  ok: boolean;
  output: string;
  isError?: boolean;
  artifact?: Artifact;
}

export interface ToolContext {
  workspace: Workspace;
  sessionId: string;
  agentId: string;
  signal: AbortSignal;
  emit(chunk: ToolOutputChunk): void;
}

export interface Tool<Args = Record<string, unknown>> {
  name: string;
  description: string;
  parametersSchema: JsonSchema;
  requiredCapabilities: Capability[];
  execute(args: Args, ctx: ToolContext): Promise<ToolResult> | AsyncIterable<ToolOutputChunk>;
}

/** Convenience constructors for tool results. */
export function ok(output: string): ToolResult {
  return { ok: true, output };
}

export function err(output: string): ToolResult {
  return { ok: false, output, isError: true };
}
