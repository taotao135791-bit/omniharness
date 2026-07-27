import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ToolRegistry, ToolResult, ToolRuntime } from "@omniharness/tool-runtime";
import type { SessionId, Workspace } from "@omniharness/shared-types";

/**
 * Live context for the run currently executing tools on a session. The
 * runtime swaps this in before each run; tool executions always go through
 * our ToolRuntime (validation → policy → approval → sandbox → sanitize →
 * audit), never through Pi's own tool implementations.
 */
export interface ToolBridgeRunContext {
  runId: string;
  sessionId: SessionId;
  agentId: string;
  workspace: Workspace;
  signal?: AbortSignal;
  /** Streams a tool output chunk to the run's event consumers. */
  emitOutput(toolCallId: string, chunk: string, stream: "stdout" | "stderr"): void;
}

export type BridgedToolCallStatus = "completed" | "failed" | "denied";

export interface BridgedToolCallRecord {
  status: BridgedToolCallStatus;
  output: string;
  startedAt: number;
  durationMs: number;
}

/**
 * ToolRuntime encodes policy/approval denials in the result text (it is
 * deliberately exception-free). These prefixes are produced by
 * tool-runtime/src/runtime.ts and are how the adapter distinguishes a denial
 * (→ `tool.call.denied`) from an ordinary failure (→ `tool.call.failed`).
 */
const DENIAL_PREFIXES = ["Policy denied ", "Approval denied for "];

export function classifyToolFailure(output: string): BridgedToolCallStatus {
  return DENIAL_PREFIXES.some((prefix) => output.startsWith(prefix)) ? "denied" : "failed";
}

/**
 * Convert every tool in our ToolRegistry into Pi's AgentTool format. Pi
 * performs its own argument validation against the plain JSON Schema
 * (pi-ai's validateToolArguments accepts non-TypeBox schemas), then our
 * ToolRuntime re-validates and runs the full enforcement pipeline.
 */
export function createAgentTools(
  registry: ToolRegistry,
  toolRuntime: ToolRuntime,
  getRunContext: () => ToolBridgeRunContext,
  records: Map<string, BridgedToolCallRecord>,
): AgentTool[] {
  const tools: AgentTool[] = [];
  for (const summary of registry.list()) {
    const tool = registry.get(summary.name);
    if (tool === undefined) continue;
    tools.push({
      name: tool.name,
      description: tool.description,
      label: tool.name,
      parameters: tool.parametersSchema as unknown as AgentTool["parameters"],
      execute: async (toolCallId, params, signal): Promise<AgentToolResult<unknown>> => {
        // ToolRuntime cannot handle an already-aborted signal (its abort and
        // timeout listeners never fire on a pre-aborted controller), and Pi
        // itself treats such calls as aborted. Short-circuit here.
        if (signal?.aborted) {
          throw new Error("Tool execution aborted");
        }
        const runContext = getRunContext();
        const startedAt = Date.now();
        const result: ToolResult = await toolRuntime.run(tool.name, params, {
          workspace: runContext.workspace,
          sessionId: runContext.sessionId,
          agentId: runContext.agentId,
          ...(signal !== undefined ? { signal } : {}),
          emit: (chunk) => {
            runContext.emitOutput(
              toolCallId,
              chunk.text,
              chunk.stream === "stderr" ? "stderr" : "stdout",
            );
          },
        });
        const record: BridgedToolCallRecord = {
          status: result.ok ? "completed" : classifyToolFailure(result.output),
          output: result.output,
          startedAt,
          durationMs: Date.now() - startedAt,
        };
        records.set(toolCallId, record);
        if (!result.ok) {
          // Throw so Pi marks the tool result as an error; the model sees the
          // denial/failure text and can react to it.
          throw new Error(result.output);
        }
        return { content: [{ type: "text", text: result.output }], details: {} };
      },
    });
  }
  return tools;
}
