import { describe, expect, it } from "vitest";
import {
  SETTINGS_SCHEMA,
  defaults,
  getPath,
  merge,
  parseCliArgs,
  setPath,
  toMarkdownDocs,
  validate,
  validateModelCapabilities,
  validatePluginManifest,
} from "./index.js";
import { DEFAULT_CAPABILITIES } from "@omniharness/shared-types";

describe("field system", () => {
  it("gets and sets dot paths", () => {
    const obj: Record<string, unknown> = {};
    setPath(obj, "daemon.port", 4242);
    expect(getPath(obj, "daemon.port")).toBe(4242);
    expect(getPath(obj, "daemon.host")).toBeUndefined();
  });

  it("produces defaults for every schema key", () => {
    const defs = defaults(SETTINGS_SCHEMA);
    for (const f of SETTINGS_SCHEMA) {
      expect(getPath(defs, f.key)).toEqual(f.default);
    }
  });

  it("validates types and enums", () => {
    const errs = validate(SETTINGS_SCHEMA, { daemon: { port: "nope" } });
    expect(errs.some((e) => e.key === "daemon.port")).toBe(true);
    const ok = validate(SETTINGS_SCHEMA, { daemon: { port: 8080, logLevel: "debug" } });
    expect(ok).toHaveLength(0);
    const badEnum = validate(SETTINGS_SCHEMA, { daemon: { logLevel: "verbose" } });
    expect(badEnum.some((e) => e.key === "daemon.logLevel")).toBe(true);
  });

  it("flags unknown top-level keys", () => {
    const errs = validate(SETTINGS_SCHEMA, { demaon: { port: 1 } });
    expect(errs.some((e) => e.key === "demaon")).toBe(true);
  });

  it("merges overrides deeply and replaces arrays", () => {
    const base = defaults(SETTINGS_SCHEMA);
    const merged = merge(base, { policy: { networkAllowlist: ["example.com"] } });
    expect(getPath(merged, "policy.networkAllowlist")).toEqual(["example.com"]);
    expect(getPath(merged, "daemon.port")).toBe(0);
  });

  it("parses CLI args into partial settings", () => {
    const { settings, errors } = parseCliArgs(SETTINGS_SCHEMA, [
      "--daemon-port",
      "7777",
      "--tui-showTokenUsage=false",
    ]);
    expect(errors).toHaveLength(0);
    expect(getPath(settings, "daemon.port")).toBe(7777);
    expect(getPath(settings, "tui.showTokenUsage")).toBe(false);
  });

  it("generates docs covering every field", () => {
    const md = toMarkdownDocs(SETTINGS_SCHEMA, "Settings");
    for (const f of SETTINGS_SCHEMA) expect(md).toContain(`\`${f.key}\``);
  });
});

describe("validators", () => {
  it("accepts default model capabilities", () => {
    expect(validateModelCapabilities(DEFAULT_CAPABILITIES)).toHaveLength(0);
  });

  it("rejects bad capabilities", () => {
    const issues = validateModelCapabilities({ ...DEFAULT_CAPABILITIES, vision: "yes" });
    expect(issues.some((i) => i.path === "vision")).toBe(true);
  });

  it("rejects plugin manifest with unknown capability", () => {
    const issues = validatePluginManifest({
      id: "p1",
      name: "P",
      version: "1.0.0",
      entry: "index.js",
      license: "MIT",
      platforms: ["macos"],
      permissions: {
        capabilities: ["fs.read", "not.a.cap"],
        tools: [],
        uiExtensions: [],
        registersProviders: false,
        secrets: [],
        networkDomains: [],
      },
    });
    expect(issues.some((i) => i.message.includes("not.a.cap"))).toBe(true);
  });
});
