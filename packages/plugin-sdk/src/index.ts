export type {
  OmniPluginApi,
  PluginEventHandler,
  PluginEventName,
  PluginEventPayload,
  PluginLogFields,
  PluginLogger,
  PluginProviderSpec,
  PluginToolContext,
  PluginToolResult,
  PluginToolSpec,
  UiExtensionDescriptor,
} from "./api.js";
export {
  IntegrityMismatchError,
  ManifestLoadError,
  ManifestValidationError,
  PermissionDeniedError,
} from "./errors.js";
export { assertCapability } from "./permissions.js";
export { loadManifest } from "./manifest.js";
export type { LoadedManifest } from "./manifest.js";
export { classifyTrust } from "./trust.js";
export type { TrustAssessment } from "./trust.js";
export { diffPermissions, hasPermissionExpansion } from "./diff.js";
export type { ListDiff, PermissionDiff } from "./diff.js";
