import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PluginManifest } from "@omniharness/shared-types";
import {
  IntegrityMismatchError,
  loadManifest,
  ManifestLoadError,
  ManifestValidationError,
} from "./index.js";

const ENTRY_SOURCE = "export function register(api) {}\n";

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function validManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "test.plugin",
    name: "Test Plugin",
    version: "1.0.0",
    description: "test",
    author: "tester",
    license: "Apache-2.0",
    entry: "index.js",
    platforms: ["macos"],
    permissions: {
      capabilities: ["fs.read"],
      tools: ["test.tool"],
      uiExtensions: [],
      registersProviders: false,
      secrets: [],
      networkDomains: [],
    },
    ...overrides,
  };
}

describe("loadManifest", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omniharness-sdk-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writePlugin(manifest: Record<string, unknown>, entry: string = ENTRY_SOURCE): void {
    writeFileSync(join(dir, "index.js"), entry);
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  }

  it("loads a valid manifest, normalizes permissions and hashes the entry", () => {
    writePlugin(validManifest());
    const loaded = loadManifest(dir);
    expect(loaded.manifest.id).toBe("test.plugin");
    expect(loaded.manifest.permissions.tools).toEqual(["test.tool"]);
    expect(loaded.integrityHash).toBe(sha256(ENTRY_SOURCE));
    expect(loaded.entryPath).toBe(join(dir, "index.js"));
  });

  it("rejects a manifest with an unknown capability", () => {
    const manifest = validManifest();
    (manifest.permissions as Record<string, unknown>).capabilities = ["fs.read", "mind.control"];
    writePlugin(manifest);
    try {
      loadManifest(dir);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ManifestValidationError);
      const err = e as ManifestValidationError;
      expect(err.issues.some((i) => i.message.includes("unknown capability"))).toBe(true);
    }
  });

  it("throws ManifestLoadError when manifest.json is missing", () => {
    expect(() => loadManifest(dir)).toThrow(ManifestLoadError);
  });

  it("throws ManifestLoadError when manifest.json is not valid JSON", () => {
    writeFileSync(join(dir, "manifest.json"), "{ not json");
    expect(() => loadManifest(dir)).toThrow(ManifestLoadError);
  });

  it("accepts a matching declared integrity hash (bare hex and sha256: prefixed)", () => {
    writePlugin(validManifest({ integrityHash: sha256(ENTRY_SOURCE) }));
    expect(loadManifest(dir).manifest.integrityHash).toBe(sha256(ENTRY_SOURCE));

    writePlugin(validManifest({ integrityHash: `sha256:${sha256(ENTRY_SOURCE)}` }));
    expect(loadManifest(dir).manifest.id).toBe("test.plugin");
  });

  it("detects an integrity mismatch", () => {
    writePlugin(validManifest({ integrityHash: sha256("different contents") }));
    try {
      loadManifest(dir);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(IntegrityMismatchError);
      const err = e as IntegrityMismatchError;
      expect(err.actual).toBe(sha256(ENTRY_SOURCE));
    }
  });

  it("rejects an entry path that escapes the plugin directory", () => {
    writePlugin(validManifest({ entry: "../outside.js" }));
    expect(() => loadManifest(dir)).toThrow(ManifestLoadError);
  });

  it("rejects a manifest missing required fields", () => {
    writePlugin({ id: "x" });
    expect(() => loadManifest(dir)).toThrow(ManifestValidationError);
  });

  it("fills defaults for omitted optional permission fields", () => {
    const manifest = validManifest();
    const perms = manifest.permissions as Record<string, unknown>;
    delete perms.uiExtensions;
    delete perms.registersProviders;
    writePlugin(manifest);
    const loaded = loadManifest(dir);
    const permissions: PluginManifest["permissions"] = loaded.manifest.permissions;
    expect(permissions.uiExtensions).toEqual([]);
    expect(permissions.registersProviders).toBe(false);
  });

  it("hashes an entry file in a subdirectory", () => {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "main.js"), ENTRY_SOURCE);
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(validManifest({ entry: "src/main.js" })));
    expect(loadManifest(dir).integrityHash).toBe(sha256(ENTRY_SOURCE));
  });
});
