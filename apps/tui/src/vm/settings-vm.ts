import { SETTINGS_SCHEMA } from "@omniharness/config-schema";
import type { FieldDef } from "@omniharness/config-schema";
import { truncate } from "./layout.js";
import { SelectableList, type ListRow } from "./selectable-list.js";

/** Groups surfaced in the TUI settings form (per product spec). */
export const TUI_SETTING_GROUPS: readonly string[] = ["tui", "daemon"];

export interface SettingRow {
  field: FieldDef;
  value: unknown;
}

export function fieldsForGroups(groups: readonly string[]): FieldDef[] {
  return SETTINGS_SCHEMA.filter((f) => groups.some((g) => f.key.startsWith(`${g}.`)));
}

export function formatValue(field: FieldDef, value: unknown): string {
  if (value === undefined) return `(default: ${JSON.stringify(field.default)})`;
  if (field.type === "string[]") return (value as string[]).join(", ");
  return String(value);
}

/** Parse user input into the field's type. Throws on invalid input. */
export function parseValue(field: FieldDef, raw: string): unknown {
  switch (field.type) {
    case "string":
      return raw;
    case "number": {
      const n = Number(raw);
      if (Number.isNaN(n)) throw new Error(`"${raw}" is not a number`);
      if (field.min !== undefined && n < field.min) throw new Error(`must be >= ${field.min}`);
      if (field.max !== undefined && n > field.max) throw new Error(`must be <= ${field.max}`);
      return n;
    }
    case "boolean":
      if (raw === "true" || raw === "1") return true;
      if (raw === "false" || raw === "0") return false;
      throw new Error("expected true or false");
    case "enum":
      if (!field.enumValues?.includes(raw)) {
        throw new Error(`expected one of: ${(field.enumValues ?? []).join(", ")}`);
      }
      return raw;
    case "string[]":
      return raw === "" ? [] : raw.split(",").map((s) => s.trim());
    case "json":
      return JSON.parse(raw) as unknown;
  }
}

/**
 * Settings view-model: a form generated from SETTINGS_SCHEMA (tui.* and
 * daemon.* groups). Values come from settings.get merged over schema
 * defaults; edits go through settings.set.
 */
export class SettingsViewModel {
  rows: SettingRow[] = [];
  loading = false;
  error: string | null = null;
  statusLine: string | null = null;
  readonly list = new SelectableList();

  setSettings(settings: Record<string, unknown>): void {
    this.loading = false;
    this.error = null;
    this.rows = fieldsForGroups(TUI_SETTING_GROUPS).map((field) => {
      const parts = field.key.split(".");
      let cur: unknown = settings;
      for (const p of parts) {
        cur = typeof cur === "object" && cur !== null ? (cur as Record<string, unknown>)[p] : undefined;
      }
      return { field, value: cur };
    });
    this.rebuildRows();
  }

  setError(message: string): void {
    this.loading = false;
    this.error = message;
  }

  private rebuildRows(): void {
    let group = "";
    const rows: ListRow[] = [];
    for (const r of this.rows) {
      const g = r.field.key.split(".")[0] ?? "";
      if (g !== group) {
        group = g;
        rows.push({ id: `h:${g}`, label: `${g}.*`, detail: "", header: true });
      }
      rows.push({
        id: r.field.key,
        label: r.field.key,
        detail: formatValue(r.field, r.value),
      });
    }
    this.list.setRows(rows);
  }

  selected(): SettingRow | undefined {
    const row = this.list.selectedRow();
    if (!row || row.header) return undefined;
    return this.rows.find((r) => r.field.key === row.id);
  }

  /** Cycle enum/boolean values in place; returns the new value to persist. */
  cycleValue(key: string, direction: 1 | -1): unknown {
    const r = this.rows.find((rr) => rr.field.key === key);
    if (!r) return undefined;
    const { field } = r;
    if (field.type === "boolean") {
      r.value = !(r.value ?? field.default);
    } else if (field.type === "enum" && field.enumValues && field.enumValues.length > 0) {
      const vals = field.enumValues;
      const cur = String(r.value ?? field.default);
      const idx = vals.indexOf(cur);
      r.value = vals[(idx + direction + vals.length) % vals.length];
    } else {
      return undefined; // numbers/strings need text input
    }
    this.rebuildRows();
    return r.value;
  }

  setValue(key: string, value: unknown): void {
    const r = this.rows.find((rr) => rr.field.key === key);
    if (!r) return;
    r.value = value;
    this.rebuildRows();
  }

  renderLines(width: number, maxVisible: number): string[] {
    if (this.loading) return ["  loading settings…"];
    if (this.error) return [truncate(`  error: ${this.error}`, width)];
    const lines: string[] = [];
    if (this.statusLine) lines.push(truncate(`  ${this.statusLine}`, width), "");
    lines.push(...this.list.renderLines(width, maxVisible));
    return lines;
  }
}
