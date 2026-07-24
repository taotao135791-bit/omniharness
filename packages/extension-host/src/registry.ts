import {
  diffPermissions,
  hasPermissionExpansion,
  loadManifest,
  type PermissionDiff,
} from "@omniharness/plugin-sdk";
import type {
  InstalledPlugin,
  IsoTimestamp,
  PluginId,
  PluginManifest,
} from "@omniharness/shared-types";
import type { ExtensionHost } from "./host.js";

/** Persistence for installed-plugin records, injected so the daemon can back it with its store. */
export interface PluginPersistence {
  list(): InstalledPlugin[];
  get(id: PluginId): InstalledPlugin | undefined;
  put(record: InstalledPlugin): void;
  remove(id: PluginId): void;
}

export class InMemoryPluginPersistence implements PluginPersistence {
  private readonly records = new Map<PluginId, InstalledPlugin>();

  list(): InstalledPlugin[] {
    return [...this.records.values()];
  }

  get(id: PluginId): InstalledPlugin | undefined {
    return this.records.get(id);
  }

  put(record: InstalledPlugin): void {
    this.records.set(record.manifest.id, record);
  }

  remove(id: PluginId): void {
    this.records.delete(id);
  }
}

/** A staged update produced by prepareUpdate, awaiting application or confirmation. */
export interface PendingUpdate {
  pluginId: PluginId;
  dir: string;
  currentVersion: string;
  incomingManifest: PluginManifest;
  diff: PermissionDiff;
  /** True when the update grants permissions beyond what was granted at install time. */
  expanded: boolean;
}

/** Thrown when an update that expands permissions is applied without explicit confirmation. */
export class PermissionExpansionError extends Error {
  constructor(pluginId: PluginId, diff: PermissionDiff) {
    super(
      `Update for plugin "${pluginId}" expands permissions and requires explicit confirmation: ${JSON.stringify(diff)}`,
    );
    this.name = "PermissionExpansionError";
  }
}

/**
 * Tracks InstalledPlugin records and orchestrates install/enable/disable/
 * uninstall/update on top of an ExtensionHost. Update flow: prepareUpdate
 * stages the new manifest and computes the permission diff against the
 * permissions granted at install time; applyUpdate applies non-expanding
 * updates directly, while expanding updates must go through confirmUpdate.
 */
export class PluginRegistry {
  private readonly host: ExtensionHost;
  private readonly persistence: PluginPersistence;
  private readonly now: () => IsoTimestamp;

  constructor(
    host: ExtensionHost,
    persistence: PluginPersistence,
    now: () => IsoTimestamp = () => new Date().toISOString(),
  ) {
    this.host = host;
    this.persistence = persistence;
    this.now = now;
  }

  async install(dir: string): Promise<InstalledPlugin> {
    const info = this.host.install(dir);
    const record: InstalledPlugin = {
      manifest: info.manifest,
      trust: info.trust,
      enabled: false,
      installedAt: this.now(),
      grantedPermissions: structuredClone(info.manifest.permissions),
    };
    this.persistence.put(record);
    return record;
  }

  async enable(pluginId: PluginId): Promise<InstalledPlugin> {
    await this.host.enable(pluginId);
    const record = this.requireRecord(pluginId);
    record.enabled = this.host.getPlugin(pluginId)?.status === "enabled";
    this.persistence.put(record);
    return record;
  }

  disable(pluginId: PluginId): InstalledPlugin {
    this.host.unload(pluginId);
    const record = this.requireRecord(pluginId);
    record.enabled = false;
    this.persistence.put(record);
    return record;
  }

  uninstall(pluginId: PluginId): void {
    this.host.uninstall(pluginId);
    this.persistence.remove(pluginId);
  }

  get(pluginId: PluginId): InstalledPlugin | undefined {
    return this.persistence.get(pluginId);
  }

  list(): InstalledPlugin[] {
    return this.persistence.list();
  }

  /** Stage an update from a new plugin directory and compute its permission diff. */
  prepareUpdate(dir: string): PendingUpdate {
    const loaded = loadManifest(dir);
    const pluginId = loaded.manifest.id;
    const existing = this.persistence.get(pluginId);
    if (existing === undefined) {
      throw new Error(`Cannot update plugin "${pluginId}": not installed`);
    }
    const diff = diffPermissions(existing.grantedPermissions, loaded.manifest.permissions);
    return {
      pluginId,
      dir: loaded.dir,
      currentVersion: existing.manifest.version,
      incomingManifest: loaded.manifest,
      diff,
      expanded: hasPermissionExpansion(diff),
    };
  }

  /** Apply a staged update that does not expand permissions. */
  async applyUpdate(update: PendingUpdate): Promise<InstalledPlugin> {
    if (update.expanded) {
      throw new PermissionExpansionError(update.pluginId, update.diff);
    }
    return this.commitUpdate(update);
  }

  /** Apply a staged update after explicit user confirmation (required when permissions expanded). */
  async confirmUpdate(update: PendingUpdate): Promise<InstalledPlugin> {
    return this.commitUpdate(update);
  }

  private async commitUpdate(update: PendingUpdate): Promise<InstalledPlugin> {
    const existing = this.requireRecord(update.pluginId);
    const wasEnabled = existing.enabled;
    this.host.uninstall(update.pluginId);
    const info = this.host.install(update.dir);
    if (wasEnabled) {
      await this.host.enable(update.pluginId);
    }
    const record: InstalledPlugin = {
      manifest: info.manifest,
      trust: info.trust,
      enabled: wasEnabled && this.host.getPlugin(update.pluginId)?.status === "enabled",
      installedAt: existing.installedAt,
      grantedPermissions: structuredClone(update.incomingManifest.permissions),
    };
    this.persistence.put(record);
    return record;
  }

  private requireRecord(pluginId: PluginId): InstalledPlugin {
    const record = this.persistence.get(pluginId);
    if (record === undefined) {
      throw new Error(`Plugin "${pluginId}" is not installed`);
    }
    return record;
  }
}
