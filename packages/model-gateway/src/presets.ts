import type { ProviderId, ProviderKind } from "@omniharness/shared-types";

export interface ProviderPreset {
  /** Stable catalog id, e.g. "openai", "azure-openai". */
  id: string;
  kind: ProviderKind;
  displayName: string;
  /** Default base URL; absent when the URL is options-driven (Azure). */
  baseUrl?: string;
  /** Environment variable conventionally holding the API key. */
  apiKeyEnvVar?: string;
  /** Whether the endpoint speaks the OpenAI chat/completions protocol. */
  openAiCompatible: boolean;
  /** False when the transport is not implemented yet (AWS Bedrock SigV4). */
  implemented: boolean;
  note?: string;
}

/** Catalog of first-party provider presets. */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  { id: "openai", kind: "openai", displayName: "OpenAI", baseUrl: "https://api.openai.com/v1", apiKeyEnvVar: "OPENAI_API_KEY", openAiCompatible: true, implemented: true },
  { id: "anthropic", kind: "anthropic", displayName: "Anthropic", baseUrl: "https://api.anthropic.com", apiKeyEnvVar: "ANTHROPIC_API_KEY", openAiCompatible: false, implemented: true },
  { id: "openrouter", kind: "openrouter", displayName: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", apiKeyEnvVar: "OPENROUTER_API_KEY", openAiCompatible: true, implemented: true },
  { id: "groq", kind: "groq", displayName: "Groq", baseUrl: "https://api.groq.com/openai/v1", apiKeyEnvVar: "GROQ_API_KEY", openAiCompatible: true, implemented: true },
  { id: "xai", kind: "xai", displayName: "xAI (Grok)", baseUrl: "https://api.x.ai/v1", apiKeyEnvVar: "XAI_API_KEY", openAiCompatible: true, implemented: true },
  { id: "kimi", kind: "kimi", displayName: "Moonshot Kimi", baseUrl: "https://api.moonshot.ai/v1", apiKeyEnvVar: "MOONSHOT_API_KEY", openAiCompatible: true, implemented: true },
  { id: "minimax", kind: "minimax", displayName: "MiniMax", baseUrl: "https://api.minimax.io/v1", apiKeyEnvVar: "MINIMAX_API_KEY", openAiCompatible: true, implemented: true },
  { id: "deepseek", kind: "deepseek", displayName: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", apiKeyEnvVar: "DEEPSEEK_API_KEY", openAiCompatible: true, implemented: true },
  { id: "zhipu", kind: "zhipu", displayName: "Zhipu (GLM)", baseUrl: "https://open.bigmodel.cn/api/paas/v4", apiKeyEnvVar: "ZHIPU_API_KEY", openAiCompatible: true, implemented: true },
  { id: "aliyun", kind: "aliyun", displayName: "Aliyun (Qwen)", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", apiKeyEnvVar: "DASHSCOPE_API_KEY", openAiCompatible: true, implemented: true },
  { id: "volcano", kind: "volcano", displayName: "Volcano Engine (Doubao)", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", apiKeyEnvVar: "ARK_API_KEY", openAiCompatible: true, implemented: true },
  { id: "mistral", kind: "mistral", displayName: "Mistral", baseUrl: "https://api.mistral.ai/v1", apiKeyEnvVar: "MISTRAL_API_KEY", openAiCompatible: true, implemented: true },
  { id: "ollama", kind: "ollama", displayName: "Ollama (local)", baseUrl: "http://127.0.0.1:11434/v1", openAiCompatible: true, implemented: true, note: "Local server; no API key required." },
  { id: "lmstudio", kind: "lmstudio", displayName: "LM Studio (local)", baseUrl: "http://127.0.0.1:1234/v1", openAiCompatible: true, implemented: true, note: "Local server; no API key required." },
  {
    id: "azure-openai",
    kind: "azure-openai",
    displayName: "Azure OpenAI",
    apiKeyEnvVar: "AZURE_OPENAI_API_KEY",
    openAiCompatible: true,
    implemented: true,
    note: "Base URL is options-driven: https://{resource}.openai.azure.com/openai/deployments/{deployment} with an api-version query param. Authenticates via the api-key header.",
  },
  {
    id: "aws-bedrock",
    kind: "aws-bedrock",
    displayName: "AWS Bedrock",
    apiKeyEnvVar: "AWS_ACCESS_KEY_ID",
    openAiCompatible: false,
    implemented: false,
    note: "Bedrock requires SigV4-signed requests against https://bedrock-runtime.{region}.amazonaws.com — not implemented yet; creating a provider throws NotImplementedProviderError.",
  },
] as const;

export function getPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === id);
}

export interface AzureOpenAiPresetOptions {
  /** Azure resource name, e.g. "my-openai" for my-openai.openai.azure.com. */
  resource: string;
  /** Deployment name; becomes the URL path segment. */
  deployment: string;
  apiVersion?: string;
}

export interface ResolvedPreset {
  preset: ProviderPreset;
  providerId: ProviderId;
  baseUrl?: string;
  /** Extra query params (Azure api-version). */
  queryParams?: Record<string, string>;
  /** Header style for the key: Azure uses "api-key" instead of Bearer. */
  apiKeyHeader?: "authorization" | "api-key";
  /** Ref into the secret store: `provider:<presetId>:apiKey`. */
  apiKeyRef: string;
}

/**
 * Resolves a preset (plus options for the URL-templated ones) into concrete
 * connection settings for OpenAICompatibleProvider / AnthropicProvider.
 */
export function resolvePreset(id: string, options?: AzureOpenAiPresetOptions): ResolvedPreset {
  const preset = getPreset(id);
  if (preset === undefined) {
    throw new Error(`Unknown provider preset "${id}". Known presets: ${PROVIDER_PRESETS.map((p) => p.id).join(", ")}`);
  }
  const resolved: ResolvedPreset = {
    preset,
    providerId: preset.id as ProviderId,
    apiKeyRef: `provider:${preset.id}:apiKey`,
  };
  if (preset.kind === "azure-openai") {
    if (options === undefined || options.resource === "" || options.deployment === "") {
      throw new Error("The azure-openai preset requires options: { resource, deployment, apiVersion? }");
    }
    resolved.baseUrl = `https://${options.resource}.openai.azure.com/openai/deployments/${options.deployment}`;
    resolved.queryParams = { "api-version": options.apiVersion ?? "2024-10-21" };
    resolved.apiKeyHeader = "api-key";
  } else if (preset.baseUrl !== undefined) {
    resolved.baseUrl = preset.baseUrl;
  }
  return resolved;
}
