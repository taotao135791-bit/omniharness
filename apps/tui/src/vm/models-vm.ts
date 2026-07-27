import type { ModelDefinition, ProviderConfig } from "@omniharness/agent-protocol";
import { MODEL_ROLES, type ModelRole } from "@omniharness/shared-types";
import { fmtTokens, truncate } from "./layout.js";
import { SelectableList, type ListRow } from "./selectable-list.js";

/** Roles shown in the bindings editor (subset most relevant to users). */
export const EDITABLE_ROLES: readonly ModelRole[] = [
  "primary",
  "planner",
  "executor",
  "reviewer",
  "summarizer",
] as const;

function badges(m: ModelDefinition): string {
  const out: string[] = [];
  if (m.capabilities.vision) out.push("vision");
  if (m.capabilities.nativeToolCalling) out.push("tools");
  if (m.capabilities.reasoningControl) out.push("reasoning");
  out.push(`${fmtTokens(m.capabilities.contextWindow)}ctx`);
  return out.join(" ");
}

/**
 * Models view-model: models grouped by provider with capability badges,
 * plus role bindings (primary/planner/...). Selection ids:
 * "m:<modelId>" for models, "p:<providerId>" for provider headers.
 */
export class ModelsViewModel {
  providers: ProviderConfig[] = [];
  models: ModelDefinition[] = [];
  bindings: Partial<Record<ModelRole, string>> = {};
  loading = false;
  error: string | null = null;
  statusLine: string | null = null;
  readonly list = new SelectableList();

  setData(
    providers: ProviderConfig[],
    models: ModelDefinition[],
    bindings: Partial<Record<ModelRole, string>>,
  ): void {
    this.providers = providers;
    this.models = models;
    this.bindings = bindings;
    this.loading = false;
    this.error = null;
    this.rebuildRows();
  }

  setError(message: string): void {
    this.loading = false;
    this.error = message;
  }

  private rebuildRows(): void {
    const rows: ListRow[] = [];
    const boundIds = new Set(Object.values(this.bindings));
    const byProvider = new Map<string, ModelDefinition[]>();
    for (const m of this.models) {
      const arr = byProvider.get(m.providerId) ?? [];
      arr.push(m);
      byProvider.set(m.providerId, arr);
    }
    for (const p of this.providers) {
      const models = byProvider.get(p.id) ?? [];
      rows.push({
        id: `p:${p.id}`,
        label: `${p.displayName} (${p.kind})${p.enabled ? "" : " [disabled]"}`,
        detail: `${models.length} models`,
      });
      for (const m of models) {
        const bound = boundIds.has(m.id);
        rows.push({
          id: `m:${m.id}`,
          label: `  ${bound ? "★" : " "} ${m.displayName}${m.enabled ? "" : " [off]"}`,
          detail: badges(m),
        });
      }
    }
    // Models whose provider is not in the list (shouldn't happen, but stay real).
    const orphan = this.models.filter((m) => !this.providers.some((p) => p.id === m.providerId));
    if (orphan.length > 0) {
      rows.push({ id: "p:__other__", label: "other", detail: `${orphan.length} models` });
      for (const m of orphan) {
        rows.push({ id: `m:${m.id}`, label: `    ${m.displayName}`, detail: badges(m) });
      }
    }
    this.list.setRows(rows);
  }

  selectedModel(): ModelDefinition | undefined {
    const row = this.list.selectedRow();
    if (!row?.id.startsWith("m:")) return undefined;
    return this.models.find((m) => m.id === row.id.slice(2));
  }

  selectedProvider(): ProviderConfig | undefined {
    const row = this.list.selectedRow();
    if (!row) return undefined;
    if (row.id.startsWith("p:")) return this.providers.find((p) => p.id === row.id.slice(2));
    if (row.id.startsWith("m:")) {
      const m = this.models.find((mm) => mm.id === row.id.slice(2));
      return m ? this.providers.find((p) => p.id === m.providerId) : undefined;
    }
    return undefined;
  }

  modelDisplayName(modelId: string): string {
    return this.models.find((m) => m.id === modelId)?.displayName ?? modelId;
  }

  /** Role bindings summary rendered above the list. */
  bindingsLines(width: number): string[] {
    const lines: string[] = [];
    for (const role of EDITABLE_ROLES) {
      const bound = this.bindings[role];
      lines.push(
        truncate(`  ${role.padEnd(12)} ${bound ? this.modelDisplayName(bound) : "(default)"}`, width),
      );
    }
    return lines;
  }

  renderLines(width: number, maxVisible: number): string[] {
    if (this.loading) return ["  loading models…"];
    if (this.error) return [truncate(`  error: ${this.error}`, width)];
    const lines = [...this.bindingsLines(width), ""];
    if (this.statusLine) lines.push(truncate(`  ${this.statusLine}`, width), "");
    if (this.models.length === 0) {
      lines.push("  no models — add a provider first");
      return lines;
    }
    lines.push(...this.list.renderLines(width, maxVisible));
    return lines;
  }
}

export { MODEL_ROLES };
