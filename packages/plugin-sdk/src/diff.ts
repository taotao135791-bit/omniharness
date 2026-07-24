import type { PluginPermissions } from "@omniharness/shared-types";

/** Added/removed entries for one permission list. */
export interface ListDiff {
  added: string[];
  removed: string[];
}

/**
 * Structural diff between two permission sets. Used by the update flow:
 * any non-empty `added` side means the update expands the plugin's powers
 * and must be explicitly re-confirmed by the user.
 */
export interface PermissionDiff {
  capabilities: ListDiff;
  tools: ListDiff;
  uiExtensions: ListDiff;
  secrets: ListDiff;
  networkDomains: ListDiff;
  registersProviders: { added: boolean; removed: boolean };
}

function diffList(before: readonly string[], after: readonly string[]): ListDiff {
  const oldSet = new Set(before);
  const newSet = new Set(after);
  return {
    added: after.filter((x) => !oldSet.has(x)),
    removed: before.filter((x) => !newSet.has(x)),
  };
}

export function diffPermissions(
  oldPermissions: PluginPermissions,
  newPermissions: PluginPermissions,
): PermissionDiff {
  return {
    capabilities: diffList(oldPermissions.capabilities, newPermissions.capabilities),
    tools: diffList(oldPermissions.tools, newPermissions.tools),
    uiExtensions: diffList(oldPermissions.uiExtensions, newPermissions.uiExtensions),
    secrets: diffList(oldPermissions.secrets, newPermissions.secrets),
    networkDomains: diffList(oldPermissions.networkDomains, newPermissions.networkDomains),
    registersProviders: {
      added: newPermissions.registersProviders && !oldPermissions.registersProviders,
      removed: oldPermissions.registersProviders && !newPermissions.registersProviders,
    },
  };
}

/** True when the diff grants the plugin anything it did not already have. */
export function hasPermissionExpansion(diff: PermissionDiff): boolean {
  return (
    diff.capabilities.added.length > 0 ||
    diff.tools.added.length > 0 ||
    diff.uiExtensions.added.length > 0 ||
    diff.secrets.added.length > 0 ||
    diff.networkDomains.added.length > 0 ||
    diff.registersProviders.added
  );
}
