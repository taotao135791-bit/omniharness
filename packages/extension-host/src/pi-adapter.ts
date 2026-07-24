import type {
  OmniPluginApi,
  PluginEventName,
  PluginToolResult,
  PluginToolSpec,
} from "@omniharness/plugin-sdk";

/**
 * Pi extension compatibility seam.
 *
 * Pi extensions (docs/research/PI_AUDIT.md §3.4) are modules default-exporting
 * `ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>`. The full Pi
 * API has ~30 events and dozens of methods; OmniHarness deliberately supports
 * only a small, explicit subset, mapped onto OmniPluginApi:
 *
 * - `pi.registerTool(def)`       → `api.registerTool(...)`; Pi's 5-argument
 *   execute is reduced to `execute(args)`, and the Pi tool result
 *   (`{ content: [{type:"text",text}], isError? }`) is mapped onto
 *   PluginToolResult. TypeBox parameter schemas are passed through as plain
 *   JSON-schema descriptors.
 * - `pi.registerCommand(name, { description, handler })` → a declarative
 *   UI-extension descriptor at point `"command"`. Command handlers are Pi
 *   session-driving code; OmniHarness records the descriptor so the UI can
 *   surface the command, but does not execute the handler.
 * - `pi.on(event, handler)`      → `api.onEvent(...)` for the events in
 *   PI_SUPPORTED_EVENTS only.
 *
 * Any other Pi API access throws PiUnsupportedError at registration time, so
 * unsupported extensions fail loudly instead of being silently half-wired.
 */

/** Pi lifecycle events mapped onto OmniHarness plugin events. */
export const PI_SUPPORTED_EVENTS: Readonly<Record<string, PluginEventName>> = {
  session_start: "session.started",
  agent_end: "run.completed",
  tool_call: "approval.requested",
} as const;

export class PiUnsupportedError extends Error {
  constructor(feature: string) {
    super(
      `Pi extension feature "${feature}" is not supported by the OmniHarness adapter. ` +
        `Supported: registerTool, registerCommand, on(${Object.keys(PI_SUPPORTED_EVENTS).join(", ")})`,
    );
    this.name = "PiUnsupportedError";
  }
}

export interface PiTextContent {
  type: "text";
  text: string;
}

export interface PiToolResult {
  content: Array<PiTextContent | { type: string }>;
  isError?: boolean;
  details?: unknown;
}

/** The supported subset of Pi's ToolDefinition. */
export interface PiToolDefinition {
  name: string;
  description: string;
  /** TypeBox schema in Pi; treated as a plain JSON-schema descriptor here. */
  parameters?: Record<string, unknown>;
  execute(args: Record<string, unknown>): PiToolResult | Promise<PiToolResult>;
}

export interface PiCommandOptions {
  description?: string;
  handler?: (args: string) => unknown;
}

export type PiEventHandler = (payload: Record<string, unknown>) => void | Promise<void>;

/** The supported subset of Pi's ExtensionAPI. */
export interface PiApiSubset {
  registerTool(definition: PiToolDefinition): void;
  registerCommand(name: string, options: PiCommandOptions): void;
  on(event: string, handler: PiEventHandler): void;
}

export type PiExtensionFactory = (pi: PiApiSubset) => void | Promise<void>;

function mapPiTool(definition: PiToolDefinition): PluginToolSpec {
  return {
    name: definition.name,
    description: definition.description,
    parametersSchema: definition.parameters ?? { type: "object" },
    execute: async (args): Promise<PluginToolResult> => {
      const result = await definition.execute(args);
      const texts: string[] = [];
      for (const part of result.content) {
        if (part.type === "text") texts.push((part as PiTextContent).text);
      }
      const isError = result.isError === true;
      return {
        ok: !isError,
        output: texts.join("\n"),
        ...(isError ? { isError: true } : {}),
      };
    },
  };
}

/**
 * Wrap a Pi extension factory so it can run against an OmniPluginApi.
 * The returned function has the same shape as a plugin's `register(api)`.
 */
export function createPiEntry(
  factory: PiExtensionFactory,
): (api: OmniPluginApi) => void | Promise<void> {
  return async (api) => {
    const pi: PiApiSubset = new Proxy({} as PiApiSubset, {
      get(_target, prop): unknown {
        switch (prop) {
          case "registerTool":
            return (definition: PiToolDefinition) => api.registerTool(mapPiTool(definition));
          case "registerCommand":
            return (name: string, options: PiCommandOptions) =>
              api.registerUiExtension("command", {
                name,
                description: options?.description ?? "",
              });
          case "on":
            return (event: string, handler: PiEventHandler) => {
              const mapped = PI_SUPPORTED_EVENTS[event];
              if (mapped === undefined) throw new PiUnsupportedError(`on("${event}")`);
              api.onEvent(mapped, handler);
            };
          case "then":
            // Keep the proxy from looking like a thenable if it is ever awaited.
            return undefined;
          default:
            throw new PiUnsupportedError(String(prop));
        }
      },
    });
    await factory(pi);
  };
}
