import {
  MODEL_ROLES,
  type ModelDefinition,
  type ModelRole,
  type ProviderConfig,
} from "@omniharness/shared-types";

/**
 * Models page view-model: provider grouping, capability badges, role binding
 * editor state. Pure functions over RPC results.
 */

export interface ProviderGroup {
  provider: ProviderConfig;
  models: ModelDefinition[];
}

/** Group models under their provider, preserving provider.list order. */
export function groupByProvider(
  providers: ProviderConfig[],
  models: ModelDefinition[],
): ProviderGroup[] {
  const byProvider = new Map<string, ModelDefinition[]>();
  for (const m of models) {
    const list = byProvider.get(m.providerId) ?? [];
    list.push(m);
    byProvider.set(m.providerId, list);
  }
  return providers.map((provider) => ({
    provider,
    models: byProvider.get(provider.id) ?? [],
  }));
}

export interface CapabilityBadge {
  key: string;
  label: string;
}

/** Short badges for the capabilities a model actually has. */
export function capabilityBadges(model: ModelDefinition): CapabilityBadge[] {
  const c = model.capabilities;
  const badges: CapabilityBadge[] = [];
  if (c.vision) badges.push({ key: "vision", label: "vision" });
  if (c.audioInput) badges.push({ key: "audio", label: "audio" });
  if (c.nativeToolCalling) badges.push({ key: "tools", label: "tools" });
  if (c.reasoningControl) badges.push({ key: "reasoning", label: "reasoning" });
  if (c.promptCaching) badges.push({ key: "cache", label: "cache" });
  if (c.structuredOutput) badges.push({ key: "json", label: "json" });
  if (c.supportsComputerUse) badges.push({ key: "computer", label: "computer-use" });
  return badges;
}

export const ROLE_LIST: readonly ModelRole[] = MODEL_ROLES;

export interface RoleBindingRow {
  role: ModelRole;
  modelId: string | null;
  /** True when the row was edited locally and not yet saved. */
  dirty: boolean;
}

/** Build editor rows from the daemon's binding map. */
export function bindingRows(
  bindings: Partial<Record<ModelRole, string>>,
  edits: Partial<Record<ModelRole, string | null>>,
): RoleBindingRow[] {
  return MODEL_ROLES.map((role) => {
    const edited = role in edits;
    const modelId = edited ? (edits[role] ?? null) : (bindings[role] ?? null);
    const clean = bindings[role] ?? null;
    return { role, modelId, dirty: edited && modelId !== clean };
  });
}

/** Apply a selection change to the local edit map. */
export function editBinding(
  edits: Partial<Record<ModelRole, string | null>>,
  role: ModelRole,
  modelId: string | null,
): Partial<Record<ModelRole, string | null>> {
  return { ...edits, [role]: modelId };
}

export function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M ctx`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k ctx`;
  return `${tokens} ctx`;
}

export function formatPrice(model: ModelDefinition): string {
  const i = model.costPerMInputTokens;
  const o = model.costPerMOutputTokens;
  if (i === undefined && o === undefined) return "local/free";
  return `$${(i ?? 0).toFixed(2)}/$${(o ?? 0).toFixed(2)} per 1M`;
}
