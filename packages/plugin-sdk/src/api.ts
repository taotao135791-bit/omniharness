import type { Capability } from "@omniharness/shared-types";

/**
 * The contract plugin authors write against. A plugin entry module exports
 * `register(api: OmniPluginApi)` and declares everything it does — tools,
 * providers, UI extensions, event hooks — through this object. The extension
 * host supplies an implementation scoped to the plugin's manifest
 * permissions; nothing outside this object is reachable from plugin code.
 */

/** Minimal tool-execution context handed to plugin tools. */
export interface PluginToolContext {
  signal: AbortSignal;
}

/** Result shape returned by plugin tools (mirrors tool-runtime's ToolResult). */
export interface PluginToolResult {
  ok: boolean;
  output: string;
  isError?: boolean;
}

/**
 * Tool shape plugins register. Same shape as tool-runtime's `Tool` minus the
 * host-owned bookkeeping; `requiredCapabilities` is optional here and the
 * host treats a missing list as "no extra capabilities".
 */
export interface PluginToolSpec {
  name: string;
  description: string;
  /** JSON Schema subset, same shape as tool-runtime's JsonSchema. */
  parametersSchema: Record<string, unknown>;
  /** Capabilities the tool needs at execution time; defaults to []. */
  requiredCapabilities?: Capability[];
  execute(
    args: Record<string, unknown>,
    ctx: PluginToolContext,
  ): PluginToolResult | Promise<PluginToolResult>;
}

/**
 * Declarative provider descriptor. The SDK never constructs providers —
 * the host reads this spec and builds the real provider with daemon-held
 * credentials.
 */
export interface PluginProviderSpec {
  id: string;
  name: string;
  /** Wire protocol / provider family, e.g. "openai-compatible". */
  kind: string;
  baseUrl?: string;
  models?: string[];
  metadata?: Record<string, unknown>;
}

/** A declarative UI contribution: a named extension point plus JSON payload. */
export interface UiExtensionDescriptor {
  point: string;
  payload: Record<string, unknown>;
}

/** Lifecycle events a plugin may subscribe to. */
export type PluginEventName = "session.started" | "run.completed" | "approval.requested";

export interface PluginEventPayload {
  [key: string]: unknown;
}

export type PluginEventHandler = (payload: PluginEventPayload) => void | Promise<void>;

export interface PluginLogFields {
  [key: string]: unknown;
}

/** Structured logger injected by the host; plugins must not use console. */
export interface PluginLogger {
  debug(message: string, fields?: PluginLogFields): void;
  info(message: string, fields?: PluginLogFields): void;
  warn(message: string, fields?: PluginLogFields): void;
  error(message: string, fields?: PluginLogFields): void;
}

/** The sandboxed API surface handed to a plugin's `register()` function. */
export interface OmniPluginApi {
  /** Register a tool. The name must be declared in manifest permissions.tools. */
  registerTool(tool: PluginToolSpec): void;
  /** Declare a model provider. Requires manifest permissions.registersProviders. */
  registerProvider(spec: PluginProviderSpec): void;
  /** Contribute a declarative UI extension. The point must be declared in manifest permissions.uiExtensions. */
  registerUiExtension(point: string, payload: Record<string, unknown>): void;
  /** Subscribe to a lifecycle event. */
  onEvent(event: PluginEventName, handler: PluginEventHandler): void;
  /** Plugin-scoped settings, as configured by the user. */
  getConfig(): Record<string, unknown>;
  /** Structured logger scoped to this plugin. */
  readonly log: PluginLogger;
}
