import { describe, expect, it } from "vitest";
import { SETTINGS_SCHEMA, type FieldDef } from "../schema.js";
import { coerceFieldInput, displayValue, fieldValue, groupFields } from "./settings.js";

const portField = SETTINGS_SCHEMA.find((f) => f.key === "daemon.port")!;
const themeField = SETTINGS_SCHEMA.find((f) => f.key === "gui.theme")!;
const allowlistField = SETTINGS_SCHEMA.find((f) => f.key === "policy.networkAllowlist")!;
const autoStartField = SETTINGS_SCHEMA.find((f) => f.key === "daemon.autoStart")!;

describe("groupFields", () => {
  it("groups schema fields by top-level prefix", () => {
    const groups = groupFields(SETTINGS_SCHEMA);
    const names = groups.map((g) => g.name);
    for (const expected of ["daemon", "models", "policy", "sandbox", "tui", "gui"]) {
      expect(names).toContain(expected);
    }
    const daemon = groups.find((g) => g.name === "daemon")!;
    expect(daemon.fields.every((f) => f.key.startsWith("daemon."))).toBe(true);
  });
});

describe("fieldValue / displayValue", () => {
  it("falls back to the schema default", () => {
    expect(fieldValue(portField, {})).toBe(0);
  });
  it("reads nested stored values", () => {
    const settings = { daemon: { port: 7777 } };
    expect(fieldValue(portField, settings)).toBe(7777);
    expect(displayValue(portField, settings)).toBe("7777");
  });
  it("renders string[] as comma-separated", () => {
    expect(displayValue(allowlistField, { policy: { networkAllowlist: ["a.com", "b.com"] } })).toBe(
      "a.com, b.com",
    );
  });
});

describe("coerceFieldInput", () => {
  it("coerces numbers and enforces min/max", () => {
    expect(coerceFieldInput(portField, "8080")).toEqual({ ok: true, value: 8080 });
    expect(coerceFieldInput(portField, "70000").ok).toBe(false);
    expect(coerceFieldInput(portField, "abc").ok).toBe(false);
  });
  it("validates enum values", () => {
    expect(coerceFieldInput(themeField, "light")).toEqual({ ok: true, value: "light" });
    expect(coerceFieldInput(themeField, "neon").ok).toBe(false);
  });
  it("splits string[] input", () => {
    expect(coerceFieldInput(allowlistField, "a.com, b.com ,,")).toEqual({
      ok: true,
      value: ["a.com", "b.com"],
    });
  });
  it("passes booleans through", () => {
    expect(coerceFieldInput(autoStartField, false)).toEqual({ ok: true, value: false });
    expect(coerceFieldInput(autoStartField, "true")).toEqual({ ok: true, value: true });
  });
  it("rejects invalid values with the schema validator", () => {
    const tempField: FieldDef = SETTINGS_SCHEMA.find((f) => f.key === "models.temperature")!;
    expect(coerceFieldInput(tempField, "5").ok).toBe(false); // max 2
  });
});
