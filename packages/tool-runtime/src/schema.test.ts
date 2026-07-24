import { describe, expect, it } from "vitest";
import { validateArgs } from "./index.js";

const schema = {
  type: "object",
  properties: {
    path: { type: "string" },
    count: { type: "integer" },
    ratio: { type: "number" },
    flag: { type: "boolean" },
    mode: { enum: ["a", "b"] },
    tags: { type: "array", items: { type: "string" } },
    nested: {
      type: "object",
      properties: { x: { type: "string" } },
      required: ["x"],
    },
  },
  required: ["path"],
  additionalProperties: false,
} as const;

describe("validateArgs", () => {
  it("accepts valid input", () => {
    const r = validateArgs(schema, { path: "p", count: 1, ratio: 0.5, mode: "a", tags: ["x"], nested: { x: "y" } });
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it("rejects wrong types", () => {
    const r = validateArgs(schema, { path: 42 });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain("expected string");
  });

  it("rejects non-integer for integer", () => {
    expect(validateArgs(schema, { path: "p", count: 1.5 }).ok).toBe(false);
    expect(validateArgs(schema, { path: "p", count: 2 }).ok).toBe(true);
  });

  it("rejects missing required and additional properties", () => {
    const r = validateArgs(schema, { nope: true });
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toContain('missing required property "path"');
    expect(r.errors.join("\n")).toContain('additional property "nope" is not allowed');
  });

  it("enforces enum and nested required", () => {
    expect(validateArgs(schema, { path: "p", mode: "c" }).ok).toBe(false);
    const r = validateArgs(schema, { path: "p", nested: {} });
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain("nested");
  });

  it("validates array items", () => {
    const r = validateArgs(schema, { path: "p", tags: ["ok", 3] });
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain("tags[1]");
  });

  it("supports additionalProperties as a schema", () => {
    const s = { type: "object", additionalProperties: { type: "string" } } as const;
    expect(validateArgs(s, { a: "x" }).ok).toBe(true);
    expect(validateArgs(s, { a: 1 }).ok).toBe(false);
  });
});
