export type {
  ChatMessage,
  ChatRole,
  CompletionRequest,
  MessagePart,
  ModelProvider,
  RouterRequest,
  TextPart,
  ToolCallPart,
  ToolResultPart,
  ToolSpec,
} from "./types.js";
export { messageText, textMessage } from "./types.js";

export {
  BudgetExceededError,
  NoModelForRoleError,
  NotImplementedProviderError,
  ProviderHttpError,
  isRateLimitError,
  isRetryableProviderError,
  isTransientServerError,
} from "./errors.js";

export type { SseEvent } from "./sse.js";
export { AnthropicSseMapper, OpenAiSseMapper, SseDecoder, parseSseText } from "./sse.js";

export { OpenAICompatibleProvider } from "./openai-compatible.js";
export type { OpenAiCompatibleOptions } from "./openai-compatible.js";
export { AnthropicProvider } from "./anthropic.js";
export type { AnthropicProviderOptions } from "./anthropic.js";
export { FixtureProvider, fixture } from "./fixture.js";
export type { FixtureResponse } from "./fixture.js";

export { PROVIDER_PRESETS, getPreset, resolvePreset } from "./presets.js";
export type { AzureOpenAiPresetOptions, ProviderPreset, ResolvedPreset } from "./presets.js";
export { createProviderFromConfig } from "./factory.js";

export { KNOWN_MODEL_OVERRIDES, ModelCapabilityRegistry, capabilitiesFor } from "./capabilities.js";
export type { ModelCapabilityOverride } from "./capabilities.js";

export { ToolCallCompatLayer } from "./compat.js";
export type { ParsedCompatResponse } from "./compat.js";

export { ModelRouter } from "./router.js";
export type {
  ModelRouterOptions,
  ProviderHealth,
  RouterBudget,
  UsageRecord,
  UsageRecorder,
} from "./router.js";
