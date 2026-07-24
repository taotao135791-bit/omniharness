import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EncryptedFileStore } from "@omniharness/secret-store";
import type { ProviderConfig, ProviderId } from "@omniharness/shared-types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NotImplementedProviderError } from "./errors.js";
import { createProviderFromConfig } from "./factory.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "omniharness-mg-"));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function config(partial: Partial<ProviderConfig> & { kind: ProviderConfig["kind"] }): ProviderConfig {
  return {
    id: "test" as ProviderId,
    displayName: "Test",
    enabled: true,
    rateLimitRpm: 0,
    timeoutMs: 30_000,
    maxRetries: 3,
    ...partial,
  };
}

describe("createProviderFromConfig", () => {
  it("throws NotImplementedProviderError for aws-bedrock with a SigV4 explanation", async () => {
    await expect(createProviderFromConfig(config({ kind: "aws-bedrock" }))).rejects.toThrow(
      NotImplementedProviderError,
    );
    await expect(createProviderFromConfig(config({ kind: "aws-bedrock" }))).rejects.toThrow(/SigV4/);
  });

  it("resolves the API key from the secret store via apiKeyRef", async () => {
    const secrets = new EncryptedFileStore(dataDir);
    await secrets.set("provider:test:apiKey", "sk-resolved");
    const provider = await createProviderFromConfig(
      config({ kind: "openai", baseUrl: "https://api.openai.com/v1", apiKeyRef: "provider:test:apiKey" }),
      secrets,
    );
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
    expect(provider.kind).toBe("openai");
    // The resolved key reaches the provider (private field, checked structurally).
    expect((provider as unknown as { apiKey?: string }).apiKey).toBe("sk-resolved");
  });

  it("refuses apiKeyRef without a secret store", async () => {
    await expect(
      createProviderFromConfig(config({ kind: "openai", baseUrl: "https://x/v1", apiKeyRef: "provider:test:apiKey" })),
    ).rejects.toThrow(/no secret store/);
  });

  it("builds an AnthropicProvider and requires its key", async () => {
    const secrets = new EncryptedFileStore(dataDir);
    await secrets.set("provider:test:apiKey", "sk-ant");
    const provider = await createProviderFromConfig(
      config({ kind: "anthropic", apiKeyRef: "provider:test:apiKey" }),
      secrets,
    );
    expect(provider).toBeInstanceOf(AnthropicProvider);
    await expect(createProviderFromConfig(config({ kind: "anthropic" }), secrets)).rejects.toThrow(/no API key/);
  });

  it("constructs the Azure OpenAI URL from options", async () => {
    const provider = await createProviderFromConfig(
      config({ kind: "azure-openai", options: { resource: "acme", deployment: "gpt-4o-prod" } }),
    );
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
    const internals = provider as unknown as { baseUrl: string; queryParams: Record<string, string>; apiKeyHeader: string };
    expect(internals.baseUrl).toBe("https://acme.openai.azure.com/openai/deployments/gpt-4o-prod");
    expect(internals.queryParams).toEqual({ "api-version": "2024-10-21" });
    expect(internals.apiKeyHeader).toBe("api-key");
  });

  it("requires a baseUrl for openai-compatible providers", async () => {
    await expect(createProviderFromConfig(config({ kind: "groq" }))).rejects.toThrow(/no baseUrl/);
  });
});
