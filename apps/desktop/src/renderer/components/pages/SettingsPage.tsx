import React, { useState } from "react";

import { SETTINGS_SCHEMA, type FieldDef } from "../../schema.js";
import type { AppStore } from "../../store.js";
import { useAppState } from "../../hooks.js";
import { coerceFieldInput, displayValue, fieldValue, groupFields } from "../../vm/settings.js";

const GROUPS = groupFields(SETTINGS_SCHEMA);

function Field({
  store,
  field,
  settings,
}: {
  store: AppStore;
  field: FieldDef;
  settings: Record<string, unknown>;
}): React.JSX.Element {
  const current = fieldValue(field, settings);
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedTick, setSavedTick] = useState(false);

  const save = async (raw: string | boolean) => {
    const coerced = coerceFieldInput(field, raw);
    if (!coerced.ok) {
      setError(coerced.error ?? "invalid value");
      return;
    }
    setError(null);
    const ok = await store.saveSetting(field.key, coerced.value);
    if (ok) {
      setDraft(null);
      setSavedTick(true);
      window.setTimeout(() => setSavedTick(false), 1500);
    } else {
      setError("save failed — see logs");
    }
  };

  const id = `setting-${field.key}`;

  return (
    <div className="setting-row">
      <label className="setting-label" htmlFor={id}>
        <code>{field.key}</code>
        <span className="muted setting-desc">{field.description}</span>
      </label>
      <div className="setting-control">
        {field.type === "boolean" ? (
          <input
            id={id}
            type="checkbox"
            checked={current === true}
            onChange={(e) => void save(e.target.checked)}
          />
        ) : field.type === "enum" ? (
          <select
            id={id}
            value={draft ?? String(current ?? "")}
            onChange={(e) => void save(e.target.value)}
          >
            {(field.enumValues ?? []).map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        ) : (
          <input
            id={id}
            type={field.type === "number" ? "number" : "text"}
            value={draft ?? displayValue(field, settings)}
            {...(field.min !== undefined ? { min: field.min } : {})}
            {...(field.max !== undefined ? { max: field.max } : {})}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void save((e.target as HTMLInputElement).value);
              if (e.key === "Escape") setDraft(null);
            }}
            onBlur={() => {
              if (draft !== null && draft !== displayValue(field, settings)) void save(draft);
              else setDraft(null);
            }}
          />
        )}
        <span className="muted setting-meta">
          {field.scope}
          {field.type === "string[]" && " · comma-separated"}
        </span>
        {error && <span className="error-text">{error}</span>}
        {savedTick && <span className="ok-text">saved</span>}
      </div>
    </div>
  );
}

export function SettingsPage({ store }: { store: AppStore }): React.JSX.Element {
  const s = useAppState(store);
  return (
    <section className="page" aria-label="Settings">
      <h1>Settings</h1>
      {GROUPS.map((g) => (
        <div key={g.name} className="settings-group">
          <h2 className="page-h2">{g.name}</h2>
          {g.fields.map((f) => (
            <Field key={f.key} store={store} field={f} settings={s.settings} />
          ))}
        </div>
      ))}
    </section>
  );
}
