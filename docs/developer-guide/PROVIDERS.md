# Providers & Models

OmniHarness is model-agnostic: the `ModelGateway` routes requests to any
provider through one interface, and every model declares capabilities the
router reasons over.

## How routing works

```
run.start ──► ModelRouter
                ├─ role bindings (primary / planner / executor / reviewer /
                │   vision / computerUse / summarizer / memoryExtractor /
                │   skillLearner / embedding / fastUtility)
                ├─ session override → profile binding → product default
                ├─ capability check (needs vision? tools? computer use?)
                ├─ retry with exponential backoff (429/5xx, Retry-After)
                ├─ fallback chain (next model when rate-limited)
                └─ usage + cost recording
```

## Adding a provider

```bash
omni provider add --kind <kind> --name <display> [--base-url <url>] [--api-key <key>]
omni provider test --provider <id>
```

| Kind                                                                                          | Notes                                  |
| --------------------------------------------------------------------------------------------- | -------------------------------------- |
| `openai`                                                                                      | api.openai.com                         |
| `anthropic`                                                                                   | api.anthropic.com, native Messages API |
| `google`                                                                                      | Gemini                                 |
| `openrouter`                                                                                  | One key, many models                   |
| `azure-openai`                                                                                | Deployment-scoped URLs via options     |
| `aws-bedrock`                                                                                 | Requires SigV4 — see KNOWN_ISSUES      |
| `mistral` / `groq` / `xai` / `kimi` / `minimax` / `deepseek` / `zhipu` / `aliyun` / `volcano` | OpenAI-compatible presets              |
| `ollama` / `lmstudio`                                                                         | Local models, no key                   |
| `openai-compatible`                                                                           | Any endpoint with a base URL           |
| `custom-plugin`                                                                               | Registered by a plugin                 |

Keys are stored via `secret-store` (macOS Keychain / Windows Credential Manager
/ libsecret / encrypted-file fallback). The database only stores a _reference_
like `provider:prov_xxx:apiKey`.

## Capability declarations

Models self-declare (`ModelCapabilities` in `packages/shared-types/src/model.ts`):
vision, native tool calling, parallel tools, structured output, reasoning
control, prompt caching, context window, max output, computer use. The router
uses these — not model names — for task assignment. Well-known models get
curated overrides (`KNOWN_MODEL_OVERRIDES` in model-gateway).

## Weak-model compatibility

When a model lacks native tool calling, the `ToolCallCompatLayer` serializes
tool specs into the prompt and parses fenced-JSON tool calls back out. This
runs in a controlled mode with reduced permissions by policy.

## Custom provider plugin

Plugins declare `registersProviders: true` and call
`api.registerProvider({ kind, displayName, factory })`. The daemon instantiates
your provider with the same `ModelProvider` interface the built-ins use.
See `plugins/examples/` for the shape.

## Budgets & limits

- `models.monthlyCostBudgetUsd` — soft cap across providers (0 = unlimited)
- Per-request timeout + max retries per provider
- Rate-limit (429) → exponential backoff → fallback chain
- Health probes with cached latency
