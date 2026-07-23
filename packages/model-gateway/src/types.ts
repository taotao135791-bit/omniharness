import type {
  ModelDefinition,
  ModelStreamChunk,
  ProviderKind,
  ToolCallRequest,
} from "@omniharness/shared-types";

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface TextPart {
  type: "text";
  text: string;
}

export interface ToolCallPart {
  type: "tool_call";
  toolCall: ToolCallRequest;
}

export interface ToolResultPart {
  type: "tool_result";
  toolCallId: string;
  content: string;
  isError?: boolean;
}

export type MessagePart = TextPart | ToolCallPart | ToolResultPart;

export interface ChatMessage {
  role: ChatRole;
  parts: MessagePart[];
}

export function textMessage(role: ChatRole, text: string): ChatMessage {
  return { role, parts: [{ type: "text", text }] };
}

/** Concatenated text of a message's text parts ("" when it has none). */
export function messageText(message: ChatMessage): string {
  return message.parts
    .filter((p): p is TextPart => p.type === "text")
    .map((p) => p.text)
    .join("");
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema object describing the tool's arguments. */
  parametersJsonSchema: Record<string, unknown>;
}

export interface CompletionRequest {
  model: ModelDefinition;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

/** A completion request with the model left for the router to resolve. */
export type RouterRequest = Omit<CompletionRequest, "model">;

export interface ModelProvider {
  readonly kind: ProviderKind;
  /** Remote model names this provider exposes (for capability seeding). */
  listModels(): Promise<string[]>;
  complete(request: CompletionRequest): AsyncIterable<ModelStreamChunk>;
}
