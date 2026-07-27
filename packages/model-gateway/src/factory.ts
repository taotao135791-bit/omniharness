import type { SecretStore } from "@omniharness/secret-store";
import type { ProviderConfig } from "@omniharness/shared-types";
import { AnthropicProvider } from "./anthropic.js";
import { NotImplementedProviderError } from "./errors.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import { resolvePreset } from "./presets.js";
import type { ModelProvider } from "./types.js";

/**
 * Builds a concrete ModelProvider from a ProviderConfig. API keys are pulled
 * from the secret store via `apiKeyRef` — config never holds the key itself.
 */
export async function createProviderFromConfig(
  config: ProviderConfig,
  secrets?: SecretStore,
): Promise<ModelProvider> {
  let apiKey: string | undefined;
  if (config.apiKeyRef !== undefined) {
    if (secrets === undefined) {
      throw new Error(
        `Provider "${config.id}" declares apiKeyRef "${config.apiKeyRef}" but no secret store was provided`,
      );
    }
    apiKey = (await secrets.get(config.apiKeyRef)) ?? undefined;
  }

  if (config.kind === "aws-bedrock") {
    throw new NotImplementedProviderError(
      "AWS Bedrock is not implemented: it requires SigV4 request signing " +
        "(AWS Signature Version 4 against bedrock-runtime.{region}.amazonaws.com), " +
        "which this gateway does not support yet. Use the anthropic or openai providers instead.",
    );
  }

  if (config.kind === "anthropic") {
    if (apiKey === undefined)
      throw new Error(`Anthropic provider "${config.id}" has no API key (apiKeyRef unresolved)`);
    return new AnthropicProvider({
      apiKey,
      ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
      ...(config.extraHeaders !== undefined ? { headers: config.extraHeaders } : {}),
    });
  }

  // Everything else speaks the OpenAI chat/completions protocol.
  let baseUrl = config.baseUrl;
  let queryParams: Record<string, string> | undefined;
  let apiKeyHeader: "authorization" | "api-key" | undefined;

  if (config.kind === "azure-openai") {
    const resource = config.options?.["resource"];
    const deployment = config.options?.["deployment"];
    if (baseUrl === undefined) {
      if (resource === undefined || deployment === undefined) {
        throw new Error(
          `Azure OpenAI provider "${config.id}" needs options { resource, deployment } when no baseUrl is set`,
        );
      }
      const resolved = resolvePreset("azure-openai", {
        resource,
        deployment,
        ...(config.options?.["apiVersion"] !== undefined
          ? { apiVersion: config.options["apiVersion"] }
          : {}),
      });
      baseUrl = resolved.baseUrl;
      queryParams = resolved.queryParams;
    } else if (config.options?.["apiVersion"] !== undefined) {
      queryParams = { "api-version": config.options["apiVersion"] };
    }
    apiKeyHeader = "api-key";
  }

  if (baseUrl === undefined) {
    throw new Error(`Provider "${config.id}" (kind "${config.kind}") has no baseUrl`);
  }
  return new OpenAICompatibleProvider({
    kind: config.kind,
    baseUrl,
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(apiKeyHeader !== undefined ? { apiKeyHeader } : {}),
    ...(config.extraHeaders !== undefined ? { headers: config.extraHeaders } : {}),
    ...(queryParams !== undefined ? { queryParams } : {}),
  });
}
