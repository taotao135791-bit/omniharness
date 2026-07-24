import type {
  FinishReason,
  ModelStreamChunk,
  TokenUsage,
  ToolCallRequest,
} from "@omniharness/shared-types";

/**
 * Server-Sent Events parsing and wire-format → ModelStreamChunk mapping.
 * Everything in this file is pure (state lives in small explicit mapper
 * objects), so the canned-SSE unit tests never touch the network.
 */

export interface SseEvent {
  /** Value of the `event:` field, if present. */
  event?: string;
  /** Concatenated `data:` lines, joined with "\n". */
  data: string;
}

function parseSseBlock(block: string): SseEvent | null {
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const rawLine of block.split(/\r?\n/)) {
    if (rawLine === "" || rawLine.startsWith(":")) continue; // blank / comment / heartbeat
    const colon = rawLine.indexOf(":");
    const field = colon === -1 ? rawLine : rawLine.slice(0, colon);
    let value = colon === -1 ? "" : rawLine.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") dataLines.push(value);
  }
  if (event === undefined && dataLines.length === 0) return null;
  const result: SseEvent = { data: dataLines.join("\n") };
  if (event !== undefined) result.event = event;
  return result;
}

/** Parses a complete SSE document into events. */
export function parseSseText(text: string): SseEvent[] {
  const events: SseEvent[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const ev = parseSseBlock(block);
    if (ev !== null) events.push(ev);
  }
  return events;
}

/** Incremental SSE decoder for streaming response bodies. */
export class SseDecoder {
  private buffer = "";

  push(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const events: SseEvent[] = [];
    for (;;) {
      const match = /\r?\n\r?\n/.exec(this.buffer);
      if (match === null || match.index === undefined) break;
      const block = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const ev = parseSseBlock(block);
      if (ev !== null) events.push(ev);
    }
    return events;
  }

  /** Parses whatever remains once the stream has ended. */
  flush(): SseEvent[] {
    const rest = this.buffer;
    this.buffer = "";
    if (rest.trim() === "") return [];
    const ev = parseSseBlock(rest);
    return ev === null ? [] : [ev];
  }
}

function mapFinishReason(raw: string | null | undefined): FinishReason {
  switch (raw) {
    case "length":
    case "max_tokens":
      return "length";
    case "tool_calls":
    case "tool_use":
      return "tool_calls";
    case "content_filter":
      return "content_filter";
    case "error":
      return "error";
    default:
      return "stop";
  }
}

// ---------------------------------------------------------------------------
// OpenAI chat/completions wire format
// ---------------------------------------------------------------------------

export interface OaiToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

export interface OaiChunk {
  choices?: Array<{
    index?: number;
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: OaiToolCallDelta[];
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  } | null;
  error?: { message?: string; type?: string };
}

/** Maps OpenAI SSE `data:` payloads to stream chunks; holds tool-call assembly state. */
export class OpenAiSseMapper {
  private readonly openToolCalls = new Map<number, ToolCallRequest>();
  private finished = false;

  /** Returns the chunks for one `data:` payload ("[DONE]" terminates). */
  pushData(data: string): ModelStreamChunk[] {
    if (data.trim() === "[DONE]") return [];
    const parsed = JSON.parse(data) as OaiChunk;
    const chunks: ModelStreamChunk[] = [];

    if (parsed.error !== undefined) {
      chunks.push({ type: "error", error: parsed.error.message ?? "unknown provider error" });
      return chunks;
    }

    for (const choice of parsed.choices ?? []) {
      const delta = choice.delta;
      if (delta !== undefined) {
        if (typeof delta.content === "string" && delta.content !== "") {
          chunks.push({ type: "text_delta", text: delta.content });
        }
        if (typeof delta.reasoning_content === "string" && delta.reasoning_content !== "") {
          chunks.push({ type: "reasoning_delta", text: delta.reasoning_content });
        }
        for (const call of delta.tool_calls ?? []) {
          const index = call.index ?? 0;
          let open = this.openToolCalls.get(index);
          if (open === undefined) {
            open = {
              id: call.id ?? `call_${index}`,
              name: call.function?.name ?? "",
              argumentsJson: "",
            };
            this.openToolCalls.set(index, open);
            chunks.push({ type: "tool_call_start", toolCall: { ...open } });
          }
          if (typeof call.function?.arguments === "string" && call.function.arguments !== "") {
            open.argumentsJson += call.function.arguments;
            chunks.push({
              type: "tool_call_delta",
              toolCallId: open.id,
              text: call.function.arguments,
            });
          }
        }
      }
      if (choice.finish_reason != null) {
        const reason = mapFinishReason(choice.finish_reason);
        if (reason === "tool_calls" || this.openToolCalls.size > 0) {
          for (const open of this.openToolCalls.values()) {
            chunks.push({ type: "tool_call_end", toolCall: { ...open }, toolCallId: open.id });
          }
          this.openToolCalls.clear();
        }
        if (!this.finished) {
          this.finished = true;
          chunks.push({ type: "finish", finishReason: reason });
        }
      }
    }

    if (parsed.usage != null) {
      const usage: TokenUsage = {
        inputTokens: parsed.usage.prompt_tokens ?? 0,
        outputTokens: parsed.usage.completion_tokens ?? 0,
        cacheReadTokens: parsed.usage.prompt_tokens_details?.cached_tokens ?? 0,
        cacheWriteTokens: 0,
      };
      chunks.push({ type: "usage", usage });
    }
    return chunks;
  }
}

// ---------------------------------------------------------------------------
// Anthropic messages wire format
// ---------------------------------------------------------------------------

export interface AnthropicEventPayload {
  type?: string;
  index?: number;
  message?: { usage?: AnthropicUsage };
  content_block?: { type?: string; text?: string; id?: string; name?: string };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    stop_reason?: string;
  };
  usage?: AnthropicUsage;
  error?: { message?: string; type?: string };
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** Maps Anthropic SSE events to stream chunks; holds tool-call assembly state. */
export class AnthropicSseMapper {
  private readonly openToolCalls = new Map<number, ToolCallRequest>();
  private sawStopReason = false;

  pushEvent(event: SseEvent): ModelStreamChunk[] {
    let payload: AnthropicEventPayload;
    try {
      payload = JSON.parse(event.data) as AnthropicEventPayload;
    } catch {
      return [{ type: "error", error: `Malformed Anthropic SSE payload: ${event.data.slice(0, 120)}` }];
    }
    const kind = event.event ?? payload.type ?? "";
    const chunks: ModelStreamChunk[] = [];

    switch (kind) {
      case "message_start": {
        const usage = payload.message?.usage;
        if (usage !== undefined) chunks.push({ type: "usage", usage: this.toUsage(usage) });
        break;
      }
      case "content_block_start": {
        const block = payload.content_block;
        const index = payload.index ?? 0;
        if (block?.type === "tool_use") {
          const call: ToolCallRequest = {
            id: block.id ?? `toolu_${index}`,
            name: block.name ?? "",
            argumentsJson: "",
          };
          this.openToolCalls.set(index, call);
          chunks.push({ type: "tool_call_start", toolCall: { ...call } });
        }
        break;
      }
      case "content_block_delta": {
        const delta = payload.delta;
        const index = payload.index ?? 0;
        if (delta?.type === "text_delta" && typeof delta.text === "string" && delta.text !== "") {
          chunks.push({ type: "text_delta", text: delta.text });
        } else if (
          delta?.type === "thinking_delta" &&
          typeof delta.thinking === "string" &&
          delta.thinking !== ""
        ) {
          chunks.push({ type: "reasoning_delta", text: delta.thinking });
        } else if (delta?.type === "input_json_delta") {
          const partial = "partial_json" in delta ? delta.partial_json : undefined;
          const open = this.openToolCalls.get(index);
          if (open !== undefined && typeof partial === "string" && partial !== "") {
            open.argumentsJson += partial;
            chunks.push({ type: "tool_call_delta", toolCallId: open.id, text: partial });
          }
        }
        break;
      }
      case "content_block_stop": {
        const index = payload.index ?? 0;
        const open = this.openToolCalls.get(index);
        if (open !== undefined) {
          this.openToolCalls.delete(index);
          chunks.push({ type: "tool_call_end", toolCall: { ...open }, toolCallId: open.id });
        }
        break;
      }
      case "message_delta": {
        const delta = payload.delta;
        if (payload.usage !== undefined) {
          chunks.push({ type: "usage", usage: this.toUsage(payload.usage) });
        }
        if (delta !== undefined && "stop_reason" in delta && delta.stop_reason != null) {
          this.sawStopReason = true;
          chunks.push({ type: "finish", finishReason: mapFinishReason(delta.stop_reason) });
        }
        break;
      }
      case "message_stop": {
        if (!this.sawStopReason) {
          this.sawStopReason = true;
          chunks.push({ type: "finish", finishReason: "stop" });
        }
        break;
      }
      case "error": {
        chunks.push({ type: "error", error: payload.error?.message ?? "unknown anthropic error" });
        break;
      }
      default:
        break; // ping and unknown events are ignored
    }
    return chunks;
  }

  private toUsage(raw: AnthropicUsage): TokenUsage {
    return {
      inputTokens: raw.input_tokens ?? 0,
      outputTokens: raw.output_tokens ?? 0,
      cacheReadTokens: raw.cache_read_input_tokens ?? 0,
      cacheWriteTokens: raw.cache_creation_input_tokens ?? 0,
    };
  }
}
