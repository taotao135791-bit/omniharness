import { DEFAULT_CAPABILITIES, type ModelId, type ProviderId } from "@omniharness/shared-types";
import { describe, expect, it } from "vitest";
import { ModelCapabilityRegistry, capabilitiesFor } from "./capabilities.js";
import { getPreset, resolvePreset } from "./presets.js";

const providerId = "openai" as ProviderId;

describe("capabilitiesFor", () => {
  it("applies well-known overrides for gpt-4o", () => {
    const caps = capabilitiesFor("gpt-4o");
    expect(caps.vision).toBe(true);
    expect(caps.nativeToolCalling).toBe(true);
    expect(caps.structuredOutput).toBe(true);
    expect(caps.contextWindow).toBe(128_000);
  });

  it("applies overrides for claude and gemini families", () => {
    expect(capabilitiesFor("claude-sonnet-4-20250514").nativeToolCalling).toBe(true);
    expect(capabilitiesFor("claude-3-haiku-20240307").contextWindow).toBe(200_000);
    expect(capabilitiesFor("gemini-2.0-flash").contextWindow).toBe(1_048_576);
  });

  it("falls back to DEFAULT_CAPABILITIES for unknown models", () => {
    expect(capabilitiesFor("some-random-model")).toEqual({ ...DEFAULT_CAPABILITIES });
  });
});

describe("ModelCapabilityRegistry", () => {
  it("seeds models from a provider with derived capabilities", () => {
    const registry = new ModelCapabilityRegistry();
    const seeded = registry.seedFromProvider(providerId, ["gpt-4o", "text-embedding-3-small"]);
    expect(seeded).toHaveLength(2);
    expect(seeded[0]?.id).toBe("openai:gpt-4o");
    expect(registry.get("openai:gpt-4o" as ModelId)?.capabilities.vision).toBe(true);
    expect(registry.get("openai:text-embedding-3-small" as ModelId)?.capabilities.nativeToolCalling).toBe(false);
  });

  it("filters by capability requirements", () => {
    const registry = new ModelCapabilityRegistry();
    registry.seedFromProvider(providerId, ["gpt-4o", "gpt-3.5-turbo", "mystery-box"]);

    const vision = registry.filterByCapability({ vision: true });
    expect(vision.map((m) => m.remoteName)).toEqual(["gpt-4o"]);

    const bigContext = registry.filterByCapability({ contextWindow: 100_000 });
    expect(bigContext.map((m) => m.remoteName).sort()).toEqual(["gpt-3.5-turbo", "gpt-4o"]);

    const toolCallers = registry.filter((caps) => caps.nativeToolCalling);
    expect(toolCallers.map((m) => m.remoteName).sort()).toEqual(["gpt-3.5-turbo", "gpt-4o"]);
  });

  it("register/unregister round-trip", () => {
    const registry = new ModelCapabilityRegistry();
    const [def] = registry.seedFromProvider(providerId, ["gpt-4o"]);
    expect(def).toBeDefined();
    if (def === undefined) throw new Error("unreachable");
    expect(registry.list()).toHaveLength(1);
    expect(registry.unregister(def.id)).toBe(true);
    expect(registry.get(def.id)).toBeUndefined();
  });
});

describe("presets", () => {
  it("builds the Azure OpenAI URL from options", () => {
    const resolved = resolvePreset("azure-openai", { resource: "acme", deployment: "gpt-4o-prod" });
    expect(resolved.baseUrl).toBe("https://acme.openai.azure.com/openai/deployments/gpt-4o-prod");
    expect(resolved.queryParams).toEqual({ "api-version": "2024-10-21" });
    expect(resolved.apiKeyHeader).toBe("api-key");
    expect(resolved.apiKeyRef).toBe("provider:azure-openai:apiKey");
  });

  it("marks aws-bedrock as not implemented with a SigV4 note", () => {
    const bedrock = getPreset("aws-bedrock");
    expect(bedrock?.implemented).toBe(false);
    expect(bedrock?.note).toMatch(/SigV4/);
  });

  it("rejects unknown presets and missing Azure options", () => {
    expect(() => resolvePreset("nope")).toThrow(/Unknown provider preset/);
    expect(() => resolvePreset("azure-openai")).toThrow(/resource.*deployment/);
  });

  it("covers the required preset catalog", () => {
    for (const id of [
      "openai", "openrouter", "groq", "xai", "kimi", "minimax", "deepseek",
      "zhipu", "aliyun", "volcano", "mistral", "ollama", "lmstudio",
      "azure-openai", "aws-bedrock",
    ]) {
      expect(getPreset(id), id).toBeDefined();
    }
  });
});
