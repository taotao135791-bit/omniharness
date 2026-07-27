import type { ModelStreamChunk } from "@omniharness/shared-types";
import { ProviderHttpError } from "./errors.js";
import { postSse, type FetchLike } from "./http.js";
import { AnthropicSseMapper } from "./sse.js";
import type { ChatMessage, CompletionRequest, ModelProvider, ToolSpec } from "./types.js";
import { messageText } from "./types.js";

export interface AnthropicProviderOptions {
  baseUrl?: string;
  apiKey: string;
  /** Defaults to a current stable Messages API version. */
  apiVersion?: string;
  headers?: Record<string, string>;
  fetchImpl?: FetchLike;
}

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const DEFAULT_API_VERSION = "2023-06-01";

type AnthropicContentBlock = Record<string, unknown>;

interface AnthropicOutMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

function toAnthropicMessages(messages: ChatMessage[]): {
  system: string | undefined;
  messages: AnthropicOutMessage[];
} {
  const systemParts: string[] = [];
  const out: AnthropicOutMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      const text = messageText(msg);
      if (text !== "") systemParts.push(text);
      continue;
    }
    if (msg.role === "tool") {
      // Tool results travel as tool_result blocks inside a user message.
      const blocks: AnthropicContentBlock[] = [];
      for (const part of msg.parts) {
        if (part.type === "tool_result") {
          blocks.push({
            type: "tool_result",
            tool_use_id: part.toolCallId,
            content: part.content,
            ...(part.isError === true ? { is_error: true } : {}),
          });
        }
      }
      if (blocks.length > 0) out.push({ role: "user", content: blocks });
      continue;
    }
    if (msg.role === "assistant") {
      const blocks: AnthropicContentBlock[] = [];
      const text = messageText(msg);
      if (text !== "") blocks.push({ type: "text", text });
      for (const part of msg.parts) {
        if (part.type === "tool_call") {
          let input: unknown = {};
          try {
            input = JSON.parse(part.toolCall.argumentsJson);
          } catch {
            input = {};
          }
          blocks.push({
            type: "tool_use",
            id: part.toolCall.id,
            name: part.toolCall.name,
            input,
          });
        }
      }
      out.push({ role: "assistant", content: blocks.length > 0 ? blocks : "" });
      continue;
    }
    out.push({ role: "user", content: messageText(msg) });
  }
  return { system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined, messages: out };
}

function toAnthropicTools(tools: ToolSpec[]): AnthropicContentBlock[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parametersJsonSchema,
  }));
}

/** Provider for the Anthropic Messages API (SSE streaming, tool_use/tool_result). */
export class AnthropicProvider implements ModelProvider {
  readonly kind = "anthropic" as const;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly apiVersion: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: FetchLike;

  constructor(options: AnthropicProviderOptions) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.apiVersion = options.apiVersion ?? DEFAULT_API_VERSION;
    this.headers = options.headers ?? {};
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private authHeaders(): Record<string, string> {
    return {
      "x-api-key": this.apiKey,
      "anthropic-version": this.apiVersion,
      ...this.headers,
    };
  }

  async listModels(): Promise<string[]> {
    const res = await this.fetchImpl(`${this.baseUrl}/v1/models`, { headers: this.authHeaders() });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ProviderHttpError(
        res.status,
        `listModels failed with HTTP ${res.status}: ${text.slice(0, 300)}`,
      );
    }
    const json = (await res.json()) as { data?: Array<{ id?: string }> };
    return (json.data ?? []).flatMap((m) => (typeof m.id === "string" ? [m.id] : []));
  }

  async *complete(request: CompletionRequest): AsyncGenerator<ModelStreamChunk> {
    const { system, messages } = toAnthropicMessages(request.messages);
    const body: Record<string, unknown> = {
      model: request.model.remoteName,
      messages,
      max_tokens: request.maxTokens ?? 4096,
      stream: true,
    };
    if (system !== undefined) body.system = system;
    if (request.tools !== undefined && request.tools.length > 0)
      body.tools = toAnthropicTools(request.tools);
    if (request.temperature !== undefined) body.temperature = request.temperature;

    const mapper = new AnthropicSseMapper();
    const events = postSse({
      url: `${this.baseUrl}/v1/messages`,
      headers: this.authHeaders(),
      body,
      fetchImpl: this.fetchImpl,
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
    });
    for await (const ev of events) {
      for (const chunk of mapper.pushEvent(ev)) yield chunk;
    }
  }
}
