import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PluginId } from "@omniharness/shared-types";
import {
  ExtensionHost,
  InMemoryPluginPersistence,
  PermissionExpansionError,
  PluginRegistry,
  type HostLogger,
} from "./index.js";

const silentLogger: HostLogger = { info: () => {}, warn: () => {}, error: () => {} };

function baseManifest(
  id: string,
  version: string,
  permissions: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    name: id,
    version,
    description: "test fixture",
    author: "tester",
    license: "Apache-2.0",
    entry: "index.js",
    platforms: ["macos"],
    permissions: {
      capabilities: [],
      tools: ["test.tool"],
      uiExtensions: [],
      registersProviders: false,
      secrets: [],
      networkDomains: [],
      ...permissions,
    },
  };
}

const ENTRY = `export function register(api) {
  api.registerTool({
    name: "test.tool",
    description: "fixture tool",
    parametersSchema: { type: "object" },
    async execute() { return { ok: true, output: "fixture" }; },
  });
}`;

describe("PluginRegistry", () => {
  let dir: string;
  let host: ExtensionHost;
  let registry: PluginRegistry;
  let counter: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omniharness-registry-test-"));
    host = new ExtensionHost({ logger: silentLogger });
    registry = new PluginRegistry(
      host,
      new InMemoryPluginPersistence(),
      () => "2026-01-01T00:00:00.000Z",
    );
    counter = 0;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writePlugin(manifest: Record<string, unknown>, entry: string = ENTRY): string {
    counter += 1;
    const pluginDir = join(dir, `plugin-${counter}`);
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, "manifest.json"), JSON.stringify(manifest), {
      encoding: "utf8",
      flag: "w",
    });
    writeFileSync(join(pluginDir, "index.js"), entry, { encoding: "utf8", flag: "w" });
    return pluginDir;
  }

  it("installs, enables, disables and uninstalls with persistence", async () => {
    const pluginDir = writePlugin(baseManifest("test.lifecycle", "1.0.0"));
    const record = await registry.install(pluginDir);
    const id: PluginId = record.manifest.id;
    expect(record.enabled).toBe(false);
    expect(record.installedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(record.grantedPermissions.tools).toEqual(["test.tool"]);
    expect(record.trust).toBe("unsigned");

    const enabled = await registry.enable(id);
    expect(enabled.enabled).toBe(true);
    expect(host.tools.has("test.tool")).toBe(true);

    const disabled = registry.disable(id);
    expect(disabled.enabled).toBe(false);
    expect(host.tools.has("test.tool")).toBe(false);

    registry.uninstall(id);
    expect(registry.get(id)).toBeUndefined();
    expect(registry.list()).toEqual([]);
    expect(host.getPlugin(id)).toBeUndefined();
  });

  it("applies a non-expanding update without confirmation", async () => {
    const v1 = writePlugin(baseManifest("test.update", "1.0.0"));
    const record = await registry.install(v1);
    await registry.enable(record.manifest.id);

    // v2 drops a capability the plugin no longer needs: not an expansion.
    const v2 = writePlugin(baseManifest("test.update", "2.0.0", { capabilities: [], secrets: [] }));
    const pending = registry.prepareUpdate(v2);
    expect(pending.pluginId).toBe(record.manifest.id);
    expect(pending.currentVersion).toBe("1.0.0");
    expect(pending.expanded).toBe(false);

    const updated = await registry.applyUpdate(pending);
    expect(updated.manifest.version).toBe("2.0.0");
    expect(updated.enabled).toBe(true);
    expect(updated.installedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(host.tools.has("test.tool")).toBe(true);
  });

  it("blocks an update with expanded permissions until explicitly confirmed", async () => {
    const v1 = writePlugin(baseManifest("test.expansion", "1.0.0"));
    const record = await registry.install(v1);
    await registry.enable(record.manifest.id);

    const v2 = writePlugin(
      baseManifest("test.expansion", "2.0.0", {
        capabilities: ["shell.exec"],
        networkDomains: ["api.example.com"],
      }),
    );
    const pending = registry.prepareUpdate(v2);
    expect(pending.expanded).toBe(true);
    expect(pending.diff.capabilities.added).toEqual(["shell.exec"]);
    expect(pending.diff.networkDomains.added).toEqual(["api.example.com"]);

    await expect(registry.applyUpdate(pending)).rejects.toBeInstanceOf(PermissionExpansionError);
    // The old version is untouched while the update is unconfirmed.
    expect(registry.get(record.manifest.id)?.manifest.version).toBe("1.0.0");
    expect(host.getPlugin(record.manifest.id)?.status).toBe("enabled");

    const confirmed = await registry.confirmUpdate(pending);
    expect(confirmed.manifest.version).toBe("2.0.0");
    expect(confirmed.enabled).toBe(true);
    expect(confirmed.grantedPermissions.capabilities).toEqual(["shell.exec"]);
    expect(confirmed.grantedPermissions.networkDomains).toEqual(["api.example.com"]);
  });

  it("rejects prepareUpdate for a plugin that is not installed", () => {
    const orphan = writePlugin(baseManifest("test.orphan", "1.0.0"));
    expect(() => registry.prepareUpdate(orphan)).toThrow(/not installed/);
  });

  it("keeps the plugin disabled across an update if it was disabled", async () => {
    const v1 = writePlugin(baseManifest("test.disabled-update", "1.0.0"));
    const record = await registry.install(v1);
    const v2 = writePlugin(baseManifest("test.disabled-update", "1.1.0"));
    const pending = registry.prepareUpdate(v2);
    const updated = await registry.applyUpdate(pending);
    expect(updated.enabled).toBe(false);
    expect(host.getPlugin(record.manifest.id)?.status).toBe("installed");
  });
});
