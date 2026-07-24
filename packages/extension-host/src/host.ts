import { readFileSync } from "node:fs";
import { createContext, runInContext, type Context } from "node:vm";
import {
  classifyTrust,
  loadManifest,
  PermissionDeniedError,
  type OmniPluginApi,
  type PluginEventHandler,
  type PluginEventName,
  type PluginEventPayload,
  type PluginLogger,
  type PluginProviderSpec,
  type PluginToolSpec,
  type UiExtensionDescriptor,
} from "@omniharness/plugin-sdk";
import type { Capability, PluginId, PluginManifest, PluginTrustLevel } from "@omniharness/shared-types";
import { ToolRegistry, type JsonSchema, type Tool, type ToolContext, type ToolResult } from "@omniharness/tool-runtime";
import { compilePluginEntry } from "./compile.js";
import { createPiEntry, type PiExtensionFactory } from "./pi-adapter.js";

/**
 * Host-side decision point for capability checks. Called before a plugin
 * tool that declares `requiredCapabilities` is allowed to execute. The
 * default permits everything; the daemon injects its policy engine here.
 */
export interface CapabilityChecker {
  check(capability: Capability, pluginId: PluginId): boolean;
}

export const permitAllCapabilities: CapabilityChecker = { check: () => true };

export type PluginStatus = "installed" | "enabled" | "disabled" | "errored";

export type PluginErrorPhase = "register" | "execute" | "event";

export interface PluginError {
  phase: PluginErrorPhase;
  message: string;
}

export interface HostedPluginInfo {
  manifest: PluginManifest;
  dir: string;
  trust: PluginTrustLevel;
  status: PluginStatus;
  warnings: string[];
  error: PluginError | null;
  tools: string[];
  uiExtensions: UiExtensionDescriptor[];
  providers: PluginProviderSpec[];
}

export interface HostLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

const consoleHostLogger: HostLogger = {
  info: (message, fields) => console.info(`[extension-host] ${message}`, fields ?? ""),
  warn: (message, fields) => console.warn(`[extension-host] ${message}`, fields ?? ""),
  error: (message, fields) => console.error(`[extension-host] ${message}`, fields ?? ""),
};

export interface ExtensionHostOptions {
  capabilityChecker?: CapabilityChecker;
  logger?: HostLogger;
  getPluginConfig?: (pluginId: PluginId) => Record<string, unknown>;
}

interface EventSubscription {
  event: PluginEventName;
  handler: PluginEventHandler;
}

interface LoadedPlugin {
  info: HostedPluginInfo;
  entryPath: string;
  handlers: EventSubscription[];
  context: Context | null;
}

type RegisterFn = (api: OmniPluginApi) => void | Promise<void>;

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
}

/**
 * Runs plugins without full daemon trust. Plugin entries execute inside a
 * `node:vm` context whose only capabilities are the scoped OmniPluginApi
 * object — there is no require, process, fs, or network in the sandbox, so
 * those are denied by absence rather than by checks. Declared manifest
 * permissions are enforced on the API surface (tool/provider/ui registration)
 * and at tool execution time via the injected CapabilityChecker. Plugin
 * faults never propagate: register/execute/event errors are caught, logged,
 * and the plugin is marked errored while the host stays alive.
 */
export class ExtensionHost {
  /** Tools registered by enabled plugins, ready for the tool runtime. */
  readonly tools = new ToolRegistry();

  private readonly plugins = new Map<PluginId, LoadedPlugin>();
  private readonly capabilityChecker: CapabilityChecker;
  private readonly logger: HostLogger;
  private readonly getPluginConfig: (pluginId: PluginId) => Record<string, unknown>;

  constructor(options: ExtensionHostOptions = {}) {
    this.capabilityChecker = options.capabilityChecker ?? permitAllCapabilities;
    this.logger = options.logger ?? consoleHostLogger;
    this.getPluginConfig = options.getPluginConfig ?? (() => ({}));
  }

  /** Load + validate a plugin's manifest and record it (status: installed). */
  install(dir: string): HostedPluginInfo {
    const loaded = loadManifest(dir);
    const id = loaded.manifest.id;
    if (this.plugins.has(id)) {
      throw new Error(`Plugin "${id}" is already installed`);
    }
    const trust = classifyTrust(loaded.dir, loaded.manifest);
    for (const warning of trust.warnings) {
      this.logger.warn(warning, { pluginId: id });
    }
    const plugin: LoadedPlugin = {
      info: {
        manifest: loaded.manifest,
        dir: loaded.dir,
        trust: trust.level,
        status: "installed",
        warnings: trust.warnings,
        error: null,
        tools: [],
        uiExtensions: [],
        providers: [],
      },
      entryPath: loaded.entryPath,
      handlers: [],
      context: null,
    };
    this.plugins.set(id, plugin);
    return plugin.info;
  }

  /**
   * Load the entry module in an isolated vm context and call its
   * `register(api)` (or adapt a Pi-style default export). Errors are caught
   * and the plugin is marked errored — this method never throws for plugin
   * faults.
   */
  async enable(pluginId: PluginId): Promise<void> {
    const plugin = this.requirePlugin(pluginId);
    if (plugin.info.status === "enabled") return;
    plugin.info.status = "installed";
    plugin.info.error = null;

    try {
      const register = this.loadEntry(plugin);
      await register(this.createApi(plugin));
      plugin.info.status = "enabled";
      this.logger.info(`Plugin "${pluginId}" enabled`, {
        pluginId,
        tools: plugin.info.tools,
      });
    } catch (cause) {
      this.unload(pluginId);
      this.failPlugin(plugin, "register", cause);
    }
  }

  /** Remove the plugin's tools and event handlers; status becomes disabled. */
  unload(pluginId: PluginId): void {
    const plugin = this.plugins.get(pluginId);
    if (plugin === undefined) return;
    for (const name of plugin.info.tools) {
      this.tools.unregister(name);
    }
    plugin.info.tools = [];
    plugin.handlers = [];
    plugin.context = null;
    if (plugin.info.status !== "errored") {
      plugin.info.status = "disabled";
    }
  }

  /** Unload and forget the plugin entirely. */
  uninstall(pluginId: PluginId): void {
    this.unload(pluginId);
    this.plugins.delete(pluginId);
  }

  getPlugin(pluginId: PluginId): HostedPluginInfo | undefined {
    return this.plugins.get(pluginId)?.info;
  }

  listPlugins(): HostedPluginInfo[] {
    return [...this.plugins.values()].map((p) => p.info);
  }

  /** Dispatch a lifecycle event to subscribed handlers of enabled plugins. */
  async emitEvent(event: PluginEventName, payload: PluginEventPayload): Promise<void> {
    for (const plugin of this.plugins.values()) {
      if (plugin.info.status !== "enabled") continue;
      for (const subscription of plugin.handlers) {
        if (subscription.event !== event) continue;
        try {
          await subscription.handler(payload);
        } catch (cause) {
          this.failPlugin(plugin, "event", cause);
        }
      }
    }
  }

  private requirePlugin(pluginId: PluginId): LoadedPlugin {
    const plugin = this.plugins.get(pluginId);
    if (plugin === undefined) {
      throw new Error(`Plugin "${pluginId}" is not installed`);
    }
    return plugin;
  }

  private failPlugin(plugin: LoadedPlugin, phase: PluginErrorPhase, cause: unknown): void {
    plugin.info.status = "errored";
    plugin.info.error = { phase, message: errorMessage(cause) };
    this.logger.error(`Plugin "${plugin.info.manifest.id}" ${phase} failure`, {
      pluginId: plugin.info.manifest.id,
      error: plugin.info.error.message,
    });
  }

  /**
   * Evaluate the entry file inside a fresh vm context. The context globals
   * are exactly: `module`, `exports`, and a `console` wired to the plugin
   * logger. Anything else — process, require, fs, fetch — is a ReferenceError
   * inside the sandbox.
   */
  private loadEntry(plugin: LoadedPlugin): RegisterFn {
    const source = readFileSync(plugin.entryPath, "utf8");
    const compiled = compilePluginEntry(source);
    const pluginId = plugin.info.manifest.id;

    const moduleHolder: { exports: Record<string, unknown> } = { exports: {} };
    const pluginLog = this.createPluginLogger(pluginId);
    const sandbox: Record<string, unknown> = {
      module: moduleHolder,
      exports: moduleHolder.exports,
      console: {
        log: (msg: unknown) => pluginLog.info(String(msg)),
        info: (msg: unknown) => pluginLog.info(String(msg)),
        warn: (msg: unknown) => pluginLog.warn(String(msg)),
        error: (msg: unknown) => pluginLog.error(String(msg)),
        debug: (msg: unknown) => pluginLog.debug(String(msg)),
      },
    };
    const context = createContext(sandbox, { name: `omniharness-plugin:${pluginId}` });
    plugin.context = context;
    runInContext(compiled, context, { filename: `${pluginId}/index.js`, timeout: 5000 });

    const exported = moduleHolder.exports;
    if (typeof exported.register === "function") {
      return exported.register as RegisterFn;
    }
    if (typeof exported.default === "function") {
      // Pi compatibility seam: a default-exported factory is adapted onto the
      // supported Pi API subset (see pi-adapter.ts).
      return createPiEntry(exported.default as PiExtensionFactory);
    }
    throw new Error(
      `Plugin "${pluginId}" entry must export register(api) or a Pi-style default factory`,
    );
  }

  private createPluginLogger(pluginId: PluginId): PluginLogger {
    const wrap =
      (level: "debug" | "info" | "warn" | "error") =>
      (message: string, fields?: Record<string, unknown>): void => {
        const sink = level === "debug" ? "info" : level;
        this.logger[sink](message, { pluginId, level, ...fields });
      };
    return { debug: wrap("debug"), info: wrap("info"), warn: wrap("warn"), error: wrap("error") };
  }

  private createApi(plugin: LoadedPlugin): OmniPluginApi {
    const { manifest } = plugin.info;
    const pluginId = manifest.id;
    const permissions = manifest.permissions;

    return {
      registerTool: (spec: PluginToolSpec): void => {
        if (!permissions.tools.includes(spec.name)) {
          throw new PermissionDeniedError(pluginId, `tool:${spec.name}`);
        }
        const tool = this.wrapTool(plugin, spec);
        this.tools.register(tool);
        plugin.info.tools.push(spec.name);
      },
      registerProvider: (spec: PluginProviderSpec): void => {
        if (!permissions.registersProviders) {
          throw new PermissionDeniedError(pluginId, "provider:register");
        }
        plugin.info.providers.push(spec);
      },
      registerUiExtension: (point: string, payload: Record<string, unknown>): void => {
        if (!permissions.uiExtensions.includes(point)) {
          throw new PermissionDeniedError(pluginId, `ui:${point}`);
        }
        plugin.info.uiExtensions.push({ point, payload });
      },
      onEvent: (event: PluginEventName, handler: PluginEventHandler): void => {
        plugin.handlers.push({ event, handler });
      },
      getConfig: (): Record<string, unknown> => this.getPluginConfig(pluginId),
      log: this.createPluginLogger(pluginId),
    };
  }

  /**
   * Convert a plugin tool spec into a runtime Tool. Execution first checks
   * each declared required capability against the injected CapabilityChecker,
   * then delegates to the plugin's execute. Plugin exceptions are caught,
   * mark the plugin errored, and surface as an error ToolResult.
   */
  private wrapTool(plugin: LoadedPlugin, spec: PluginToolSpec): Tool {
    const pluginId = plugin.info.manifest.id;
    const requiredCapabilities = [...(spec.requiredCapabilities ?? [])];
    return {
      name: spec.name,
      description: spec.description,
      parametersSchema: spec.parametersSchema as JsonSchema,
      requiredCapabilities,
      execute: async (args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> => {
        for (const capability of requiredCapabilities) {
          if (!this.capabilityChecker.check(capability, pluginId)) {
            return {
              ok: false,
              output: `Permission denied: plugin "${pluginId}" lacks capability "${capability}"`,
              isError: true,
            };
          }
        }
        try {
          const result = await spec.execute(args, { signal: ctx.signal });
          const toolResult: ToolResult = { ok: result.ok, output: result.output };
          if (result.isError === true) toolResult.isError = true;
          return toolResult;
        } catch (cause) {
          this.failPlugin(plugin, "execute", cause);
          return {
            ok: false,
            output: `Plugin "${pluginId}" tool "${spec.name}" failed: ${errorMessage(cause)}`,
            isError: true,
          };
        }
      },
    };
  }
}
