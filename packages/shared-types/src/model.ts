import type { ModelId, ProviderId } from "./ids.js";

/** Declared capabilities of a model — the router reasons over these, never over names. */
export interface ModelCapabilities {
  text: boolean;
  vision: boolean;
  audioInput: boolean;
  nativeToolCalling: boolean;
  parallelToolCalling: boolean;
  structuredOutput: boolean;
  reasoningControl: boolean;
  promptCaching: boolean;
  /** Total context window in tokens. */
  contextWindow: number;
  maxOutputTokens: number;
  supportsSystemMessage: boolean;
  supportsStreaming: boolean;
  supportsComputerUse: boolean;
}

export const DEFAULT_CAPABILITIES: ModelCapabilities = {
  text: true,
  vision: false,
  audioInput: false,
  nativeToolCalling: false,
  parallelToolCalling: false,
  structuredOutput: false,
  reasoningControl: false,
  promptCaching: false,
  contextWindow: 32_768,
  maxOutputTokens: 4_096,
  supportsSystemMessage: true,
  supportsStreaming: true,
  supportsComputerUse: false,
};

export type ProviderKind =
  | "openai"
  | "anthropic"
  | "google"
  | "openrouter"
  | "azure-openai"
  | "aws-bedrock"
  | "mistral"
  | "groq"
  | "xai"
  | "kimi"
  | "minimax"
  | "deepseek"
  | "zhipu"
  | "aliyun"
  | "volcano"
  | "ollama"
  | "lmstudio"
  | "openai-compatible"
  | "fixture" // deterministic fake for tests
  | "custom-plugin";

export interface ProviderConfig {
  id: ProviderId;
  kind: ProviderKind;
  displayName: string;
  baseUrl?: string;
  /** Reference into the secret store — never the key itself. */
  apiKeyRef?: string;
  region?: string;
  enabled: boolean;
  /** Requests per minute; 0 = unlimited. */
  rateLimitRpm: number;
  timeoutMs: number;
  maxRetries: number;
  extraHeaders?: Record<string, string>;
  /** Provider-specific options (e.g. Azure deployment, Bedrock inference profile). */
  options?: Record<string, string>;
}

export interface ModelDefinition {
  id: ModelId;
  providerId: ProviderId;
  /** Name sent to the provider API. */
  remoteName: string;
  displayName: string;
  capabilities: ModelCapabilities;
  /** USD per 1M tokens; undefined = unknown/free/local. */
  costPerMInputTokens?: number;
  costPerMOutputTokens?: number;
  enabled: boolean;
}

/** Roles that can each be bound to a different model. */
export type ModelRole =
  | "primary"
  | "planner"
  | "executor"
  | "reviewer"
  | "vision"
  | "computerUse"
  | "summarizer"
  | "memoryExtractor"
  | "skillLearner"
  | "embedding"
  | "fastUtility";

export const MODEL_ROLES: readonly ModelRole[] = [
  "primary",
  "planner",
  "executor",
  "reviewer",
  "vision",
  "computerUse",
  "summarizer",
  "memoryExtractor",
  "skillLearner",
  "embedding",
  "fastUtility",
] as const;

export type RoleModelBinding = Partial<Record<ModelRole, ModelId>>;

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** USD; computed from ModelDefinition pricing when known. */
  costUsd?: number;
}

export type FinishReason = "stop" | "length" | "tool_calls" | "content_filter" | "error";

export interface ToolCallRequest {
  id: string;
  name: string;
  /** JSON-encoded arguments as produced by the model. */
  argumentsJson: string;
}

export interface ModelStreamChunk {
  type:
    | "text_delta"
    | "reasoning_delta"
    | "tool_call_start"
    | "tool_call_delta"
    | "tool_call_end"
    | "usage"
    | "finish"
    | "error";
  text?: string;
  toolCall?: ToolCallRequest;
  toolCallId?: string;
  usage?: TokenUsage;
  finishReason?: FinishReason;
  error?: string;
}
