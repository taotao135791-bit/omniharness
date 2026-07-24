import { describe, expect, it } from "vitest";
import type { PluginManifest, PluginPermissions } from "@omniharness/shared-types";
import type { PermissionDiff } from "./index.js";
import {
  assertCapability,
  classifyTrust,
  diffPermissions,
  hasPermissionExpansion,
  PermissionDeniedError,
} from "./index.js";

function manifestWith(permissions: Partial<PluginPermissions>): PluginManifest {
  return {
    id: "test.plugin" as PluginManifest["id"],
    name: "Test",
    version: "1.0.0",
    description: "test",
    author: "tester",
    license: "Apache-2.0",
    entry: "index.js",
    platforms: ["macos"],
    permissions: {
      capabilities: [],
      tools: [],
      uiExtensions: [],
      registersProviders: false,
      secrets: [],
      networkDomains: [],
      ...permissions,
    },
  };
}

describe("assertCapability", () => {
  it("passes when the capability is declared", () => {
    const manifest = manifestWith({ capabilities: ["fs.read"] });
    expect(() => assertCapability(manifest, "fs.read")).not.toThrow();
  });

  it("throws PermissionDeniedError when the capability is missing", () => {
    const manifest = manifestWith({ capabilities: ["fs.read"] });
    try {
      assertCapability(manifest, "shell.exec");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(PermissionDeniedError);
      const err = e as PermissionDeniedError;
      expect(err.pluginId).toBe("test.plugin");
      expect(err.permission).toBe("capability:shell.exec");
    }
  });
});

describe("diffPermissions", () => {
  const base: PluginPermissions = {
    capabilities: ["fs.read"],
    tools: ["a.tool", "b.tool"],
    uiExtensions: [],
    registersProviders: false,
    secrets: ["API_KEY"],
    networkDomains: ["example.com"],
  };

  it("reports added and removed entries per list", () => {
    const next: PluginPermissions = {
      ...base,
      capabilities: ["fs.read", "shell.exec"],
      tools: ["b.tool", "c.tool"],
      secrets: [],
      networkDomains: ["example.com", "api.example.com"],
    };
    const diff: PermissionDiff = diffPermissions(base, next);
    expect(diff.capabilities).toEqual({ added: ["shell.exec"], removed: [] });
    expect(diff.tools).toEqual({ added: ["c.tool"], removed: ["a.tool"] });
    expect(diff.secrets).toEqual({ added: [], removed: ["API_KEY"] });
    expect(diff.networkDomains).toEqual({ added: ["api.example.com"], removed: [] });
    expect(diff.registersProviders).toEqual({ added: false, removed: false });
  });

  it("tracks registersProviders flips in both directions", () => {
    expect(diffPermissions(base, { ...base, registersProviders: true }).registersProviders).toEqual(
      { added: true, removed: false },
    );
    expect(
      diffPermissions({ ...base, registersProviders: true }, base).registersProviders,
    ).toEqual({ added: false, removed: true });
  });

  it("hasPermissionExpansion is false for pure removals and true for additions", () => {
    const removedOnly = diffPermissions(base, {
      ...base,
      tools: ["a.tool"],
      capabilities: [],
    });
    expect(hasPermissionExpansion(removedOnly)).toBe(false);

    const expanded = diffPermissions(base, { ...base, networkDomains: ["example.com", "x.com"] });
    expect(hasPermissionExpansion(expanded)).toBe(true);
  });
});

describe("classifyTrust", () => {
  const manifest = manifestWith({});

  it("classifies plugins inside plugins/bundled as bundled", () => {
    const assessment = classifyTrust("/opt/omniharness/plugins/bundled/notes", manifest);
    expect(assessment.level).toBe("bundled");
    expect(assessment.warnings).toEqual([]);
  });

  it("classifies a structurally valid signature as signed", () => {
    const signed = { ...manifest, signature: `ed25519:${"a".repeat(64)}` };
    expect(classifyTrust("/tmp/community-plugin", signed).level).toBe("signed");
  });

  it("treats a malformed signature as unsigned with a warning", () => {
    const malformed = { ...manifest, signature: "not-a-signature" };
    const assessment = classifyTrust("/tmp/community-plugin", malformed);
    expect(assessment.level).toBe("unsigned");
    expect(assessment.warnings.some((w) => w.includes("malformed signature"))).toBe(true);
  });

  it("warns for unsigned plugins", () => {
    const assessment = classifyTrust("/tmp/community-plugin", manifest);
    expect(assessment.level).toBe("unsigned");
    expect(assessment.warnings.some((w) => w.includes("unsigned"))).toBe(true);
  });

  it("does not treat a random 'bundled' directory as product-bundled", () => {
    expect(classifyTrust("/home/user/bundled/notes", manifest).level).toBe("unsigned");
  });
});
