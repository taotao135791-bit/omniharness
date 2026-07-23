import type { ToolCallRequest } from "@omniharness/shared-types";
import type { ChatMessage, ToolSpec } from "./types.js";
import { textMessage } from "./types.js";

const FENCE = "```json";

export interface ParsedCompatResponse {
  /** Response text with consumed tool-call fences removed. */
  text: string;
  toolCalls: ToolCallRequest[];
}

interface CompatToolCallWire {
  id?: string;
  name: string;
  arguments?: Record<string, unknown>;
}

/**
 * Bridges tool calling for models without native function-calling support
 * (capabilities.nativeToolCalling === false). Tool specs are serialized into
 * the system prompt; the model answers with a fenced JSON block; results are
 * fed back the same way. The wire format is fully deterministic so prompts
 * are reproducible and the parser is trivially unit-testable.
 */
export class ToolCallCompatLayer {
  private nextCallSeq = 1;

  /** Instructions + tool JSON that get injected as a system message. */
  buildToolPrompt(tools: ToolSpec[]): string {
    const catalog = tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parametersJsonSchema,
    }));
    return [
      "You may call tools to answer. The available tools are described by this JSON array:",
      JSON.stringify(catalog, null, 2),
      "",
      "To call one or more tools, include EXACTLY ONE fenced block of the following form in your reply:",
      FENCE,
      '{"tool_calls":[{"name":"<tool name>","arguments":{}}]}',
      "```",
      "Each entry in \"tool_calls\" must use one of the listed tool names and arguments matching its JSON schema.",
      "Put any regular answer text outside the fenced block. If you do not need a tool, answer normally.",
    ].join("\n");
  }

  /** Returns messages with the tool prompt prepended as a system message (merged into an existing one). */
  injectTools(messages: ChatMessage[], tools: ToolSpec[]): ChatMessage[] {
    if (tools.length === 0) return messages;
    const prompt = this.buildToolPrompt(tools);
    const [first, ...rest] = messages;
    if (first !== undefined && first.role === "system") {
      const merged = textMessage("system", `${prompt}\n\n${this.messageText(first)}`);
      return [merged, ...rest];
    }
    return [textMessage("system", prompt), ...messages];
  }

  /**
   * Extracts tool calls from the first valid `{"tool_calls":[...]}` fenced
   * JSON block in the model output. Malformed fences are left in the text.
   * Call ids are taken from the block when present, otherwise generated
   * deterministically (`compat_1`, `compat_2`, ...).
   */
  parseResponse(text: string): ParsedCompatResponse {
    const fencePattern = /```json\s*\n([\s\S]*?)```/g;
    let match: RegExpExecArray | null;
    while ((match = fencePattern.exec(text)) !== null) {
      const rawJson = match[1];
      if (rawJson === undefined) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawJson);
      } catch {
        continue; // not JSON — leave untouched
      }
      if (!this.isToolCallBlock(parsed)) continue;
      const toolCalls: ToolCallRequest[] = parsed.tool_calls.map((call) => ({
        id: call.id ?? `compat_${this.nextCallSeq++}`,
        name: call.name,
        argumentsJson: JSON.stringify(call.arguments ?? {}),
      }));
      const cleaned = (text.slice(0, match.index) + text.slice(match.index + match[0].length)).trim();
      return { text: cleaned, toolCalls };
    }
    return { text: text.trim(), toolCalls: [] };
  }

  /** Serializes a tool result as a fenced JSON user message for the next turn. */
  formatToolResult(call: ToolCallRequest, result: string, isError = false): ChatMessage {
    let args: unknown = {};
    try {
      args = JSON.parse(call.argumentsJson);
    } catch {
      args = {};
    }
    const block = {
      tool_result: {
        id: call.id,
        name: call.name,
        arguments: args,
        result,
        is_error: isError,
      },
    };
    return textMessage("user", `${FENCE}\n${JSON.stringify(block, null, 2)}\n\`\`\``);
  }

  private isToolCallBlock(value: unknown): value is { tool_calls: CompatToolCallWire[] } {
    if (typeof value !== "object" || value === null) return false;
    const calls = (value as { tool_calls?: unknown }).tool_calls;
    if (!Array.isArray(calls)) return false;
    return calls.every(
      (c) =>
        typeof c === "object" &&
        c !== null &&
        typeof (c as { name?: unknown }).name === "string" &&
        ((c as { arguments?: unknown }).arguments === undefined ||
          typeof (c as { arguments?: unknown }).arguments === "object"),
    );
  }

  private messageText(message: ChatMessage): string {
    return message.parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("");
  }
}
