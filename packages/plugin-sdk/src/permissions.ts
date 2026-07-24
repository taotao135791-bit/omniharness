import type { Capability, PluginManifest } from "@omniharness/shared-types";
import { PermissionDeniedError } from "./errors.js";

/**
 * Assert that a plugin's manifest declares a capability; throws
 * PermissionDeniedError otherwise. Used by the host before granting a plugin
 * access to capability-gated functionality.
 */
export function assertCapability(manifest: PluginManifest, capability: Capability): void {
  if (!manifest.permissions.capabilities.includes(capability)) {
    throw new PermissionDeniedError(manifest.id, `capability:${capability}`);
  }
}
