import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolContext, ToolResult } from "@omniharness/tool-runtime";
import type { Capability, PluginId, ProjectId, WorkspaceId } from "@omniharness/shared-types";
import { ExtensionHost, type CapabilityChecker, type HostLogger } from "./index.js";

const HELLO_TOOL_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "plugins",
  "examples",
  "hello-tool",
);

function fakeContext(): ToolContext {
  return {
    workspace: {
      id: "ws_test" as WorkspaceId,
      projectId: "prj_test" as ProjectId,
      name: "test",
      kind: "folder",
      roots: ["/tmp"],
      protectedPaths: [],
      readOnlyPaths: [],
      createdAt: new Date().toISOString(),
    },
    sessionId: "ses_test",
    agentId: "agt_test",
    signal: new AbortController().signal,
    emit: () => {},
  };
}

interface LogEntry {
  level: string;
  message: string;
}

function captureLogger(): { logger: HostLogger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const make = (level: string) => (message: string) => {
    entries.push({ level, message });
  };
  return {
    logger: { info: make("info"), warn: make("warn"), error: make("error") },
    entries,
  };
}

function baseManifest(
  id: string,
  permissions: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    name: id,
    version: "1.0.0",
    description: "test fixture",
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

describe("ExtensionHost", () => {
  let dir: string;
  let counter: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omniharness-host-test-"));
    counter = 0;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writePlugin(manifest: Record<string, unknown>, entry: string): string {
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

  async function executeTool(
    host: ExtensionHost,
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const tool = host.tools.get(name);
    if (tool === undefined) throw new Error(`tool ${name} not registered`);
    const result = tool.execute(args, fakeContext());
    if (Symbol.asyncIterator in Object(result)) throw new Error("unexpected stream result");
    return result as Promise<ToolResult>;
  }

  it("installs, enables and executes the bundled hello-tool example", async () => {
    const { logger, entries } = captureLogger();
    const host = new ExtensionHost({ logger });
    const info = host.install(HELLO_TOOL_DIR);
    expect(info.status).toBe("installed");
    expect(info.trust).toBe("unsigned");
    // unsigned warning is recorded on the plugin and surfaced to the logger
    expect(info.warnings.some((w) => w.includes("unsigned"))).toBe(true);
    expect(entries.some((e) => e.level === "warn" && e.message.includes("unsigned"))).toBe(true);

    await host.enable(info.manifest.id);
    expect(host.getPlugin(info.manifest.id)?.status).toBe("enabled");
    expect(host.tools.has("example.hello")).toBe(true);

    const result = await executeTool(host, "example.hello", { name: "World" });
    expect(result.ok).toBe(true);
    expect(result.output).toBe("Hello, World!");
  });

  it("rejects registering a tool that is not declared in manifest permissions", async () => {
    const { logger } = captureLogger();
    const host = new ExtensionHost({ logger });
    const pluginDir = writePlugin(
      baseManifest("test.undeclared", { tools: ["test.declared"] }),
      `export function register(api) {
        api.registerTool({
          name: "test.sneaky",
          description: "not declared",
          parametersSchema: { type: "object" },
          async execute() { return { ok: true, output: "sneaky" }; },
        });
      }`,
    );
    const info = host.install(pluginDir);
    await host.enable(info.manifest.id);

    const after = host.getPlugin(info.manifest.id);
    expect(after?.status).toBe("errored");
    expect(after?.error?.phase).toBe("register");
    expect(after?.error?.message).toContain("PermissionDeniedError");
    expect(host.tools.has("test.sneaky")).toBe(false);
  });

  it("enforces the injected CapabilityChecker at tool execution time", async () => {
    const checked: Array<{ capability: Capability; pluginId: PluginId }> = [];
    const denyShell: CapabilityChecker = {
      check: (capability, pluginId) => {
        checked.push({ capability, pluginId });
        return capability !== "shell.exec";
      },
    };
    const host = new ExtensionHost({
      capabilityChecker: denyShell,
      logger: captureLogger().logger,
    });
    const pluginDir = writePlugin(
      baseManifest("test.caps", {
        tools: ["test.shell"],
        capabilities: ["shell.exec"],
      }),
      `export function register(api) {
        api.registerTool({
          name: "test.shell",
          description: "needs shell",
          parametersSchema: { type: "object" },
          requiredCapabilities: ["shell.exec"],
          async execute() { return { ok: true, output: "ran shell" }; },
        });
      }`,
    );
    const info = host.install(pluginDir);
    await host.enable(info.manifest.id);
    expect(host.getPlugin(info.manifest.id)?.status).toBe("enabled");

    const denied = await executeTool(host, "test.shell", {});
    expect(denied.ok).toBe(false);
    expect(denied.isError).toBe(true);
    expect(denied.output).toContain("shell.exec");
    expect(checked).toEqual([{ capability: "shell.exec", pluginId: info.manifest.id }]);

    // A checker that permits the capability lets the same tool through.
    const allowHost = new ExtensionHost({ logger: captureLogger().logger });
    allowHost.install(pluginDir);
    await allowHost.enable(info.manifest.id);
    const allowed = await executeTool(allowHost, "test.shell", {});
    expect(allowed.ok).toBe(true);
    expect(allowed.output).toBe("ran shell");
  });

  it("isolates a plugin that throws in register and keeps the host alive", async () => {
    const host = new ExtensionHost({ logger: captureLogger().logger });
    const crashyDir = writePlugin(
      baseManifest("test.crashy-register"),
      `export function register(api) { throw new Error("boom in register"); }`,
    );
    const crashy = host.install(crashyDir);
    await host.enable(crashy.manifest.id);

    const info = host.getPlugin(crashy.manifest.id);
    expect(info?.status).toBe("errored");
    expect(info?.error?.phase).toBe("register");
    expect(info?.error?.message).toContain("boom in register");

    // The host is unaffected: another plugin still installs and runs.
    const good = host.install(HELLO_TOOL_DIR);
    await host.enable(good.manifest.id);
    const result = await executeTool(host, "example.hello", { name: "Still Alive" });
    expect(result.output).toBe("Hello, Still Alive!");
  });

  it("isolates a plugin that throws during tool execution and marks it errored", async () => {
    const host = new ExtensionHost({ logger: captureLogger().logger });
    const pluginDir = writePlugin(
      baseManifest("test.crashy-execute", { tools: ["test.boom"] }),
      `export function register(api) {
        api.registerTool({
          name: "test.boom",
          description: "throws when executed",
          parametersSchema: { type: "object" },
          async execute() { throw new Error("boom in execute"); },
        });
      }`,
    );
    const info = host.install(pluginDir);
    await host.enable(info.manifest.id);
    expect(host.getPlugin(info.manifest.id)?.status).toBe("enabled");

    const result = await executeTool(host, "test.boom", {});
    expect(result.ok).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("boom in execute");

    const after = host.getPlugin(info.manifest.id);
    expect(after?.status).toBe("errored");
    expect(after?.error?.phase).toBe("execute");

    // Host still works for other plugins.
    const good = host.install(HELLO_TOOL_DIR);
    await host.enable(good.manifest.id);
    expect((await executeTool(host, "example.hello", { name: "X" })).output).toBe("Hello, X!");
  });

  it("denies process/require/fs inside the vm sandbox by absence", async () => {
    const host = new ExtensionHost({ logger: captureLogger().logger });
    const cases: Array<[string, string]> = [
      [
        "test.sandbox-process",
        `export function register(api) { api.log.info(String(process.pid)); }`,
      ],
      ["test.sandbox-require", `export function register(api) { require("node:fs"); }`],
      ["test.sandbox-fs", `export function register(api) { fs.readFileSync("/etc/passwd"); }`],
    ];
    for (const [id, entry] of cases) {
      const pluginDir = writePlugin(baseManifest(id), entry);
      const info = host.install(pluginDir);
      await host.enable(info.manifest.id);
      const after = host.getPlugin(info.manifest.id);
      expect(after?.status).toBe("errored");
      expect(after?.error?.phase).toBe("register");
      expect(after?.error?.message).toMatch(/ReferenceError/);
    }
    // The host itself survived all three escape attempts.
    const good = host.install(HELLO_TOOL_DIR);
    await host.enable(good.manifest.id);
    expect(host.tools.has("example.hello")).toBe(true);
  });

  it("dispatches lifecycle events to enabled plugins only", async () => {
    const host = new ExtensionHost({ logger: captureLogger().logger });
    const pluginDir = writePlugin(
      baseManifest("test.events"),
      `export function register(api) {
        api.onEvent("session.started", (payload) => {
          api.log.info("session started: " + payload.sessionId);
        });
      }`,
    );
    const { logger, entries } = captureLogger();
    void logger;
    const host2 = new ExtensionHost({ logger, getPluginConfig: () => ({}) });
    const info = host2.install(pluginDir);
    await host2.enable(info.manifest.id);
    await host2.emitEvent("session.started", { sessionId: "ses_1" });
    expect(entries.some((e) => e.message.includes("session started: ses_1"))).toBe(true);

    host2.unload(info.manifest.id);
    await host2.emitEvent("session.started", { sessionId: "ses_2" });
    expect(entries.some((e) => e.message.includes("ses_2"))).toBe(false);
    expect(host2.getPlugin(info.manifest.id)?.status).toBe("disabled");

    void host;
  });

  it("enforces provider and ui-extension declarations", async () => {
    const host = new ExtensionHost({ logger: captureLogger().logger });
    const pluginDir = writePlugin(
      baseManifest("test.providers"),
      `export function register(api) {
        api.registerProvider({ id: "p", name: "P", kind: "openai-compatible" });
      }`,
    );
    const info = host.install(pluginDir);
    await host.enable(info.manifest.id);
    expect(host.getPlugin(info.manifest.id)?.status).toBe("errored");
    expect(host.getPlugin(info.manifest.id)?.error?.message).toContain("PermissionDeniedError");
  });

  it("runs Pi-style default-export extensions through the adapter", async () => {
    const host = new ExtensionHost({ logger: captureLogger().logger });
    const pluginDir = writePlugin(
      baseManifest("test.pi-ext", {
        tools: ["pi.tool"],
        uiExtensions: ["command"],
      }),
      `export default function (pi) {
        pi.registerTool({
          name: "pi.tool",
          description: "pi-style tool",
          parameters: { type: "object" },
          async execute(args) {
            return { content: [{ type: "text", text: "pi says " + args.what }] };
          },
        });
        pi.registerCommand("pi-cmd", { description: "a pi command", handler: () => {} });
        pi.on("session_start", () => {});
      }`,
    );
    const info = host.install(pluginDir);
    await host.enable(info.manifest.id);
    expect(host.getPlugin(info.manifest.id)?.status).toBe("enabled");

    const result = await executeTool(host, "pi.tool", { what: "hello" });
    expect(result.ok).toBe(true);
    expect(result.output).toBe("pi says hello");

    const uiExtensions = host.getPlugin(info.manifest.id)?.uiExtensions ?? [];
    expect(uiExtensions).toEqual([
      { point: "command", payload: { name: "pi-cmd", description: "a pi command" } },
    ]);
  });

  it("marks Pi extensions using unsupported API surface as errored", async () => {
    const host = new ExtensionHost({ logger: captureLogger().logger });
    const pluginDir = writePlugin(
      baseManifest("test.pi-unsupported"),
      `export default function (pi) {
        pi.on("before_provider_request", () => {});
      }`,
    );
    const info = host.install(pluginDir);
    await host.enable(info.manifest.id);
    const after = host.getPlugin(info.manifest.id);
    expect(after?.status).toBe("errored");
    expect(after?.error?.message).toContain("PiUnsupportedError");
  });
});
