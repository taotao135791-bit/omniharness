export { ExtensionHost, permitAllCapabilities } from "./host.js";
export type {
  CapabilityChecker,
  ExtensionHostOptions,
  HostedPluginInfo,
  HostLogger,
  PluginError,
  PluginErrorPhase,
  PluginStatus,
} from "./host.js";
export { compilePluginEntry, UnsupportedEntryError } from "./compile.js";
export { InMemoryPluginPersistence, PermissionExpansionError, PluginRegistry } from "./registry.js";
export type { PendingUpdate, PluginPersistence } from "./registry.js";
export { createPiEntry, PI_SUPPORTED_EVENTS, PiUnsupportedError } from "./pi-adapter.js";
export type {
  PiApiSubset,
  PiCommandOptions,
  PiEventHandler,
  PiExtensionFactory,
  PiTextContent,
  PiToolDefinition,
  PiToolResult,
} from "./pi-adapter.js";
