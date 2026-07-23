import type { ModelStreamChunk, ProviderKind, ToolCallRequest } from "@omniharness/shared-types";
import { postSse, type FetchLike } from "./http.js";
import { OpenAiSseMapper } from "./sse.js";
import type {
  ChatMessage,
  CompletionRequest,
  ModelProvider,
  ToolResultPart,
  ToolSpec,
} from "./types.js";
import { messageText } from "./types.js";

export interface OpenAiCompatibleOptions {
  /** Provider kind reported on the interface; defaults to "openai-compatible". */
  kind?: ProviderKind;
  /** Base URL including any version prefix, e.g. "https://api.openai.com/v1". */
  baseUrl: string;
  apiKey?: string;
  /** Header used for the API key: "authorization" (Bearer) or "api-key" (Azure). */
  apiKeyHeader?: "authorization" | "api-key";
  headers?: Record<string, string>;
  /** Extra query params appended to every request (e.g. Azure api-version). */
  queryParams?: Record<string, string>;
  fetchImpl?: FetchLike;
}

interface OaiOutMessage {
  role: string;
  content: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
}

function toOaiMessages(messages: ChatMessage[]): OaiOutMessage[] {
  const out: OaiOutMessage[] = [];
  for (const msg of messages) {
    if (msg.role === "tool") {
      for (const part of msg.parts) {
        if (part.type === "tool_result") {
          const toolPart: ToolResultPart = part;
          out.push({ role: "tool", tool_call_id: toolPart.toolCallId, content: toolPart.content });
        }
      }
      continue;
    }
    const toolCalls = msg.parts.filter((p) => p.type === "tool_call");
    const mapped: OaiOutMessage = { role: msg.role, content: messageText(msg) || null };
    if (toolCalls.length > 0) {
      mapped.tool_calls = toolCalls.map((p) => {
        const call = (p as { type: "tool_call"; toolCall: ToolCallRequest }).toolCall;
        return {
          id: call.id,
          type: "function" as const,
          function: { name: call.name, arguments: call.argumentsJson },
        };
      });
    }
    out.push(mapped);
  }
  return out;
}

function toOaiTools(tools: ToolSpec[]): Array<Record<string, unknown>> {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parametersJsonSchema },
  }));
}

/**
 * Provider for the OpenAI chat/completions API and the many compatible
 * endpoints (OpenRouter, Groq, xAI, Kimi, DeepSeek, Zhipu, Aliyun, Volcano,
 * Mistral, Ollama, LM Studio, Azure OpenAI deployments, ...).
 */
export class OpenAICompatibleProvider implements ModelProvider {
  readonly kind: ProviderKind;
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly apiKeyHeader: "authorization" | "api-key";
  private readonly headers: Record<string, string>;
  private readonly queryParams: Record<string, string>;
  private readonly fetchImpl: FetchLike;

  constructor(options: OpenAiCompatibleOptions) {
    this.kind = options.kind ?? "openai-compatible";
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    if (options.apiKey !== undefined) this.apiKey = options.apiKey;
    this.apiKeyHeader = options.apiKeyHeader ?? "authorization";
    this.headers = options.headers ?? {};
    this.queryParams = options.queryParams ?? {};
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private url(path: string): string {
    const params = new URLSearchParams(this.queryParams);
    const query = params.toString();
    return `${this.baseUrl}${path}${query !== "" ? `?${query}` : ""}`;
  }

  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = { ...this.headers };
    if (this.apiKey !== undefined && this.apiKey !== "") {
      if (this.apiKeyHeader === "api-key") headers["api-key"] = this.apiKey;
      else headers["authorization"] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  async listModels(): Promise<string[]> {
    const res = await this.fetchImpl(this.url("/models"), { headers: this.authHeaders() });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const { ProviderHttpError } = await import("./errors.js");
      throw new ProviderHttpError(res.status, `listModels failed with HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    const json = (await res.json()) as { data?: Array<{ id?: string }> };
    return (json.data ?? []).flatMap((m) => (typeof m.id === "string" ? [m.id] : []));
  }

  async *complete(request: CompletionRequest): AsyncGenerator<ModelStreamChunk> {
    const body: Record<string, unknown> = {
      model: request.model.remoteName,
      messages: toOaiMessages(request.messages),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (request.tools !== undefined && request.tools.length > 0) body.tools = toOaiTools(request.tools);
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;

    const mapper = new OpenAiSseMapper();
    const events = postSse({
      url: this.url("/chat/completions"),
      headers: this.authHeaders(),
      body,
      fetchImpl: this.fetchImpl,
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
    });
    for await (const ev of events) {
      // OpenAI-compatible streams carry no `event:` field; each event's data is one JSON payload.
      for (const chunk of mapper.pushData(ev.data)) yield chunk;
    }
  }
}
