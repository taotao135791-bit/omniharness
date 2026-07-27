import {
  DEFAULT_CAPABILITIES,
  type ModelCapabilities,
  type ModelDefinition,
  type ModelId,
  type ProviderId,
} from "@omniharness/shared-types";

export interface ModelCapabilityOverride {
  /** Matched against the remote model name (case-insensitive). */
  pattern: RegExp;
  capabilities: Partial<ModelCapabilities>;
}

/**
 * Well-known capability overrides, applied on top of DEFAULT_CAPABILITIES
 * when seeding models from a provider's model list. Order matters: the first
 * matching pattern wins.
 */
export const KNOWN_MODEL_OVERRIDES: readonly ModelCapabilityOverride[] = [
  {
    pattern: /^o[134](-|$)|^gpt-5/i,
    capabilities: {
      vision: true,
      nativeToolCalling: true,
      parallelToolCalling: true,
      structuredOutput: true,
      reasoningControl: true,
      promptCaching: true,
      contextWindow: 200_000,
      maxOutputTokens: 100_000,
    },
  },
  {
    pattern: /^gpt-4o/i,
    capabilities: {
      vision: true,
      nativeToolCalling: true,
      parallelToolCalling: true,
      structuredOutput: true,
      promptCaching: true,
      contextWindow: 128_000,
      maxOutputTokens: 16_384,
    },
  },
  {
    pattern: /^gpt-4/i,
    capabilities: {
      nativeToolCalling: true,
      parallelToolCalling: true,
      contextWindow: 128_000,
      maxOutputTokens: 8_192,
    },
  },
  {
    pattern: /^gpt-3\.5/i,
    capabilities: { nativeToolCalling: true, contextWindow: 16_385 },
  },
  {
    pattern: /^claude-(opus|sonnet|haiku)-4|^claude-4/i,
    capabilities: {
      vision: true,
      nativeToolCalling: true,
      parallelToolCalling: true,
      structuredOutput: true,
      reasoningControl: true,
      promptCaching: true,
      supportsComputerUse: true,
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
    },
  },
  {
    pattern: /^claude-3/i,
    capabilities: {
      vision: true,
      nativeToolCalling: true,
      parallelToolCalling: true,
      promptCaching: true,
      contextWindow: 200_000,
      maxOutputTokens: 8_192,
    },
  },
  {
    pattern: /^gemini-2/i,
    capabilities: {
      vision: true,
      audioInput: true,
      nativeToolCalling: true,
      parallelToolCalling: true,
      structuredOutput: true,
      reasoningControl: true,
      promptCaching: true,
      contextWindow: 1_048_576,
      maxOutputTokens: 65_536,
    },
  },
  {
    pattern: /^gemini-1\.5/i,
    capabilities: {
      vision: true,
      audioInput: true,
      nativeToolCalling: true,
      structuredOutput: true,
      promptCaching: true,
      contextWindow: 1_048_576,
      maxOutputTokens: 8_192,
    },
  },
  {
    pattern: /^(deepseek-r1|.*reasoner)/i,
    capabilities: { reasoningControl: true, contextWindow: 128_000, maxOutputTokens: 32_000 },
  },
  {
    pattern: /^deepseek/i,
    capabilities: { nativeToolCalling: true, contextWindow: 128_000, maxOutputTokens: 8_192 },
  },
  {
    pattern: /^(qwen|qwq)/i,
    capabilities: { nativeToolCalling: true, contextWindow: 131_072, maxOutputTokens: 8_192 },
  },
  {
    pattern: /^glm-4/i,
    capabilities: {
      nativeToolCalling: true,
      vision: true,
      contextWindow: 128_000,
      maxOutputTokens: 4_096,
    },
  },
  {
    pattern: /^(llama-3\.[123]|llama-4)/i,
    capabilities: { nativeToolCalling: true, contextWindow: 131_072, maxOutputTokens: 8_192 },
  },
  {
    pattern: /^mistral-(large|medium)/i,
    capabilities: {
      nativeToolCalling: true,
      parallelToolCalling: true,
      contextWindow: 131_072,
      maxOutputTokens: 8_192,
    },
  },
  {
    pattern: /^(grok-3|grok-4)/i,
    capabilities: {
      nativeToolCalling: true,
      structuredOutput: true,
      vision: true,
      contextWindow: 131_072,
      maxOutputTokens: 8_192,
    },
  },
  {
    pattern: /^(kimi-k2|moonshot-v1-128k|kimi-latest)/i,
    capabilities: { nativeToolCalling: true, contextWindow: 131_072, maxOutputTokens: 8_192 },
  },
] as const;

/** DEFAULT_CAPABILITIES plus the first matching well-known override. */
export function capabilitiesFor(remoteName: string): ModelCapabilities {
  for (const override of KNOWN_MODEL_OVERRIDES) {
    if (override.pattern.test(remoteName)) {
      return { ...DEFAULT_CAPABILITIES, ...override.capabilities };
    }
  }
  return { ...DEFAULT_CAPABILITIES };
}

export class ModelCapabilityRegistry {
  private readonly models = new Map<ModelId, ModelDefinition>();

  register(definition: ModelDefinition): void {
    this.models.set(definition.id, definition);
  }

  unregister(id: ModelId): boolean {
    return this.models.delete(id);
  }

  get(id: ModelId): ModelDefinition | undefined {
    return this.models.get(id);
  }

  list(): ModelDefinition[] {
    return [...this.models.values()];
  }

  /** All models whose capabilities satisfy the predicate. */
  filter(
    predicate: (capabilities: ModelCapabilities, definition: ModelDefinition) => boolean,
  ): ModelDefinition[] {
    return this.list().filter((def) => predicate(def.capabilities, def));
  }

  /**
   * Models matching every requirement: boolean flags must be true, numeric
   * fields (contextWindow, maxOutputTokens) must be >= the requested value.
   */
  filterByCapability(required: Partial<ModelCapabilities>): ModelDefinition[] {
    return this.filter((caps) =>
      (Object.entries(required) as Array<[keyof ModelCapabilities, boolean | number]>).every(
        ([key, value]) => {
          const actual = caps[key];
          if (typeof value === "boolean") return value ? actual === true : true;
          return typeof actual === "number" && actual >= value;
        },
      ),
    );
  }

  /**
   * Registers one ModelDefinition per remote model name, deriving
   * capabilities from DEFAULT_CAPABILITIES + KNOWN_MODEL_OVERRIDES.
   * Model ids are `<providerId>:<remoteName>`.
   */
  seedFromProvider(
    providerId: ProviderId,
    remoteNames: string[],
    options?: { enabled?: boolean },
  ): ModelDefinition[] {
    const seeded: ModelDefinition[] = [];
    for (const remoteName of remoteNames) {
      const def: ModelDefinition = {
        id: `${providerId}:${remoteName}` as ModelId,
        providerId,
        remoteName,
        displayName: remoteName,
        capabilities: capabilitiesFor(remoteName),
        enabled: options?.enabled ?? true,
      };
      this.register(def);
      seeded.push(def);
    }
    return seeded;
  }
}
