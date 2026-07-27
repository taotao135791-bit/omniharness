import type { StreamFn } from "@earendil-works/pi-agent-core";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  ImageContent,
  Model,
  TextContent,
  ThinkingContent,
  ToolCall,
  Usage,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ChatMessage, MessagePart, ModelRouter } from "@omniharness/model-gateway";
import { textMessage } from "@omniharness/model-gateway";
import type { ModelDefinition, ModelRole, ModelStreamChunk, TokenUsage } from "@omniharness/shared-types";

/**
 * Synthetic pi-ai model descriptor. Pi never talks to a provider directly —
 * the {@link StreamFn} below routes every request through the OmniHarness
 * ModelRouter, so this object only carries metadata Pi needs for its own
 * bookkeeping (context window, cost table, api label).
 */
export function toPiModel(definition: ModelDefinition): Model<Api> {
  return {
    id: definition.id,
    name: definition.displayName,
    api: "omniharness",
    provider: definition.providerId,
    baseUrl: "",
    reasoning: definition.capabilities.reasoningControl,
    input: definition.capabilities.vision ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: definition.capabilities.contextWindow,
    maxTokens: definition.capabilities.maxOutputTokens,
  };
}

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function toPiUsage(usage: TokenUsage | undefined): Usage {
  if (usage === undefined) return emptyUsage();
  const total = usage.costUsd ?? 0;
  return {
    input: usage.inputTokens,
    output: usage.outputTokens,
    cacheRead: usage.cacheReadTokens,
    cacheWrite: usage.cacheWriteTokens,
    totalTokens: usage.inputTokens + usage.outputTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
  };
}

function imagePlaceholder(content: ImageContent): string {
  return `[image omitted: ${content.mimeType}]`;
}

/** Convert Pi's LLM-facing message list into gateway ChatMessages. */
export function piContextToChatMessages(context: Context): ChatMessage[] {
  const out: ChatMessage[] = [];
  if (context.systemPrompt !== undefined && context.systemPrompt !== "") {
    out.push(textMessage("system", context.systemPrompt));
  }
  for (const message of context.messages) {
    if (message.role === "user") {
      const text =
        typeof message.content === "string"
          ? message.content
          : message.content
              .map((part) => (part.type === "text" ? part.text : imagePlaceholder(part)))
              .join("");
      out.push(textMessage("user", text));
      continue;
    }
    if (message.role === "assistant") {
      const parts: MessagePart[] = [];
      for (const part of message.content) {
        if (part.type === "text") {
          parts.push({ type: "text", text: part.text });
        } else if (part.type === "toolCall") {
          parts.push({
            type: "tool_call",
            toolCall: { id: part.id, name: part.name, argumentsJson: JSON.stringify(part.arguments) },
          });
        }
        // thinking/reasoning blocks are not replayed through the gateway.
      }
      if (parts.length > 0) out.push({ role: "assistant", parts });
      continue;
    }
    // toolResult
    const content = message.content
      .map((part) => (part.type === "text" ? part.text : imagePlaceholder(part)))
      .join("");
    out.push({
      role: "tool",
      parts: [
        {
          type: "tool_result",
          toolCallId: message.toolCallId,
          content,
          ...(message.isError ? { isError: true } : {}),
        },
      ],
    });
  }
  return out;
}

interface PendingToolCall {
  id: string;
  name: string;
  argumentsJson: string;
  contentIndex: number;
}

/**
 * Builds the Pi {@link StreamFn} that delegates every model request to our
 * ModelRouter for the given role. Role routing, fallbacks, retries, budgets
 * and usage recording all stay inside model-gateway.
 *
 * Honours the StreamFn contract: never throws; failures are encoded as a
 * final AssistantMessage with stopReason "error" (or "aborted").
 */
export function createRouterStreamFn(router: ModelRouter, role: ModelRole): StreamFn {
  return (model, context, options) => {
    const stream: AssistantMessageEventStream = createAssistantMessageEventStream();
    const signal = options?.signal;

    const partial = (): AssistantMessage => ({
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: emptyUsage(),
      stopReason: "stop",
      timestamp: Date.now(),
    });

    const fail = (message: AssistantMessage, stopReason: "error" | "aborted", errorMessage: string): void => {
      message.stopReason = stopReason;
      message.errorMessage = errorMessage;
      stream.push({ type: "error", reason: stopReason, error: message });
      stream.end(message);
    };

    void (async () => {
      const message = partial();
      if (signal?.aborted) {
        fail(message, "aborted", "Request aborted before it started");
        return;
      }
      const content: (TextContent | ThinkingContent | ToolCall)[] = [];
      const pendingToolCalls = new Map<string, PendingToolCall>();
      let usage: TokenUsage | undefined;
      let finishReason: ModelStreamChunk["finishReason"] = "stop";
      let streamError: string | undefined;

      try {
        const request = {
          messages: piContextToChatMessages(context),
          ...(context.tools !== undefined && context.tools.length > 0
            ? {
                tools: context.tools.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  parametersJsonSchema: tool.parameters as Record<string, unknown>,
                })),
              }
            : {}),
          ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
          ...(options?.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
          ...(signal !== undefined ? { signal } : {}),
        };
        stream.push({ type: "start", partial: { ...message, content: [] } });
        for await (const chunk of router.complete(role, request)) {
          if (chunk.type === "text_delta" && chunk.text !== undefined) {
            const last = content[content.length - 1];
            if (last !== undefined && last.type === "text") {
              last.text += chunk.text;
            } else {
              content.push({ type: "text", text: chunk.text });
            }
            stream.push({
              type: "text_delta",
              contentIndex: content.length - 1,
              delta: chunk.text,
              partial: { ...message, content: [...content] },
            });
            continue;
          }
          if (chunk.type === "reasoning_delta" && chunk.text !== undefined) {
            const last = content[content.length - 1];
            if (last !== undefined && last.type === "thinking") {
              last.thinking += chunk.text;
            } else {
              content.push({ type: "thinking", thinking: chunk.text });
            }
            stream.push({
              type: "thinking_delta",
              contentIndex: content.length - 1,
              delta: chunk.text,
              partial: { ...message, content: [...content] },
            });
            continue;
          }
          if (chunk.type === "tool_call_start" && chunk.toolCall !== undefined) {
            const pending: PendingToolCall = {
              id: chunk.toolCall.id,
              name: chunk.toolCall.name,
              argumentsJson: "",
              contentIndex: content.length,
            };
            pendingToolCalls.set(pending.id, pending);
            content.push({ type: "toolCall", id: pending.id, name: pending.name, arguments: {} });
            stream.push({
              type: "toolcall_start",
              contentIndex: pending.contentIndex,
              partial: { ...message, content: [...content] },
            });
            continue;
          }
          if (chunk.type === "tool_call_delta" && chunk.toolCallId !== undefined) {
            const pending = pendingToolCalls.get(chunk.toolCallId);
            if (pending !== undefined && chunk.text !== undefined) {
              pending.argumentsJson += chunk.text;
              stream.push({
                type: "toolcall_delta",
                contentIndex: pending.contentIndex,
                delta: chunk.text,
                partial: { ...message, content: [...content] },
              });
            }
            continue;
          }
          if (chunk.type === "tool_call_end" && chunk.toolCall !== undefined) {
            const id = chunk.toolCall.id;
            const pending = pendingToolCalls.get(id);
            const argumentsJson =
              chunk.toolCall.argumentsJson !== "" ? chunk.toolCall.argumentsJson : (pending?.argumentsJson ?? "");
            let args: Record<string, unknown>;
            try {
              const parsed: unknown = JSON.parse(argumentsJson === "" ? "{}" : argumentsJson);
              args =
                typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
                  ? (parsed as Record<string, unknown>)
                  : {};
            } catch {
              throw new Error(`Model emitted invalid JSON arguments for tool "${chunk.toolCall.name}"`);
            }
            const toolCall: ToolCall = { type: "toolCall", id, name: chunk.toolCall.name, arguments: args };
            const index = pending?.contentIndex ?? content.length;
            if (pending !== undefined) {
              content[pending.contentIndex] = toolCall;
              pendingToolCalls.delete(id);
            } else {
              content.push(toolCall);
            }
            stream.push({
              type: "toolcall_end",
              contentIndex: index,
              toolCall,
              partial: { ...message, content: [...content] },
            });
            continue;
          }
          if (chunk.type === "usage" && chunk.usage !== undefined) {
            usage = chunk.usage;
            continue;
          }
          if (chunk.type === "finish") {
            finishReason = chunk.finishReason ?? "stop";
            continue;
          }
          if (chunk.type === "error") {
            streamError = chunk.error ?? "Unknown provider error";
          }
        }
      } catch (error) {
        streamError = error instanceof Error ? error.message : String(error);
      }

      message.content = content;
      message.usage = toPiUsage(usage);
      if (streamError !== undefined) {
        fail(message, signal?.aborted ? "aborted" : "error", streamError);
        return;
      }
      if (signal?.aborted) {
        fail(message, "aborted", "Request aborted");
        return;
      }
      if (finishReason === "tool_calls") {
        message.stopReason = "toolUse";
        stream.push({ type: "done", reason: "toolUse", message });
      } else if (finishReason === "length") {
        message.stopReason = "length";
        stream.push({ type: "done", reason: "length", message });
      } else if (finishReason === "stop") {
        message.stopReason = "stop";
        stream.push({ type: "done", reason: "stop", message });
      } else {
        fail(message, "error", `Completion finished with reason "${String(finishReason)}"`);
        return;
      }
      stream.end(message);
    })().catch((error: unknown) => {
      // Last-resort guard: the StreamFn contract forbids throwing.
      fail(partial(), "error", error instanceof Error ? error.message : String(error));
    });

    return stream;
  };
}
