/**
 * Renderer-local re-exports of the config-schema pieces the GUI needs.
 *
 * The package index (@omniharness/config-schema) also re-exports brand.js,
 * which imports node:fs and cannot be bundled for the browser — so we import
 * the side-effect-free compiled modules directly. Keep this list minimal.
 */
export { SETTINGS_SCHEMA } from "../../../../packages/config-schema/dist/settings-schema.js";
export { getPath, validate } from "../../../../packages/config-schema/dist/field.js";
export type { FieldDef, SettingsObject } from "../../../../packages/config-schema/dist/field.js";
