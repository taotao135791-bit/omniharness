import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "vitest";
import {
  FixtureProvider,
  fixture,
  ModelCapabilityRegistry,
  ModelRouter,
} from "@omniharness/model-gateway";
import { PolicyEngine } from "@omniharness/policy-engine";
import { createCoreTools, ToolRegistry } from "@omniharness/tool-runtime";
import type { Tool } from "@omniharness/tool-runtime";
import {
  DEFAULT_CAPABILITIES,
  type ModelDefinition,
  type ModelId,
  type ProviderId,
  type ProjectId,
  type SessionId,
  type Workspace,
  type WorkspaceId,
} from "@omniharness/shared-types";
import { PiAgentRuntime } from "./index.js";
import type { RuntimeEvent } from "./index.js";

function def(id: string, contextWindow = 128_000): ModelDefinition {
  return {
    id: id as ModelId,
    providerId: "fixture" as ProviderId,
    remoteName: id,
    displayName: id,
    capabilities: { ...DEFAULT_CAPABILITIES, nativeToolCalling: true, contextWindow },
    enabled: true,
  };
}

function workspace(root: string): Workspace {
  return {
    id: "ws" as WorkspaceId,
    projectId: "p" as ProjectId,
    name: "t",
    kind: "folder",
    roots: [root],
    protectedPaths: [],
    readOnlyPaths: [],
    createdAt: new Date().toISOString(),
  };
}

async function drain(events: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const out: RuntimeEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

it("debug fs.write", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dbg-"));
  const reg = new ModelCapabilityRegistry();
  reg.register(def("fixture:main"));
  const provider = new FixtureProvider([
    fixture.toolCall("fs.write", JSON.stringify({ path: "note.txt", content: "hello file" }), "call_write"),
    fixture.text("done"),
  ]);
  const router = new ModelRouter({
    registry: reg,
    providers: new Map([["fixture", provider]]),
    bindings: { primary: "fixture:main" as ModelId },
  });
  const tools = new ToolRegistry();
  tools.registerAll(createCoreTools());
  const runtime = new PiAgentRuntime({
    router,
    registry: tools,
    policy: new PolicyEngine({ workspaceRoot: root }),
    workspace: workspace(root),
  });
  const events = await drain(runtime.startRun({ sessionId: "s" as SessionId, input: "go" }));
  console.log(JSON.stringify(events, null, 1));
}, 20000);

it("debug interrupt", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dbg-"));
  const reg = new ModelCapabilityRegistry();
  reg.register(def("fixture:main"));
  const provider = new FixtureProvider([fixture.toolCall("test.slow", "{}", "c1")]);
  const router = new ModelRouter({
    registry: reg,
    providers: new Map([["fixture", provider]]),
    bindings: { primary: "fixture:main" as ModelId },
  });
  const tools = new ToolRegistry();
  const slow: Tool = {
    name: "test.slow",
    description: "hangs",
    parametersSchema: { type: "object", properties: {}, additionalProperties: false },
    requiredCapabilities: [],
    execute: (_a, ctx) =>
      new Promise((_, reject) => {
        ctx.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
  };
  tools.register(slow);
  const runtime = new PiAgentRuntime({
    router,
    registry: tools,
    policy: new PolicyEngine({ workspaceRoot: root }),
    workspace: workspace(root),
  });
  const stream = runtime.startRun({ sessionId: "s" as SessionId, input: "go", runId: "r1" });
  const it2 = stream[Symbol.asyncIterator]();
  const events: RuntimeEvent[] = [];
  for (;;) {
    const n = await it2.next();
    if (n.done) break;
    events.push(n.value);
    console.log("EV", n.value.type);
    if (n.value.type === "tool.call.started") break;
  }
  console.log("interrupt ->", runtime.interrupt("r1"));
  const timeout = setTimeout(() => console.log("STILL WAITING"), 3000);
  for (;;) {
    const n = await it2.next();
    if (n.done) break;
    events.push(n.value);
    console.log("EV", n.value.type);
  }
  clearTimeout(timeout);
}, 20000);

it("debug compaction", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dbg-"));
  const reg = new ModelCapabilityRegistry();
  reg.register(def("fixture:main", 400));
  reg.register(def("fixture:summary", 400));
  const provider = new FixtureProvider([
    fixture.text("x".repeat(4000), { usage: { inputTokens: 500, outputTokens: 250 } }),
    fixture.text("SUMMARY"),
    fixture.text("final"),
  ]);
  const router = new ModelRouter({
    registry: reg,
    providers: new Map([["fixture", provider]]),
    bindings: { primary: "fixture:main" as ModelId, summarizer: "fixture:summary" as ModelId },
  });
  const tools = new ToolRegistry();
  const runtime = new PiAgentRuntime({
    router,
    registry: tools,
    policy: new PolicyEngine({ workspaceRoot: root }),
    workspace: workspace(root),
    compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 60 },
  });
  const r1 = await drain(runtime.startRun({ sessionId: "s" as SessionId, input: "hi" }));
  console.log("run1:", r1.map((e) => e.type).join(","));
  const r2 = await drain(runtime.startRun({ sessionId: "s" as SessionId, input: "again" }));
  console.log("run2:", JSON.stringify(r2, null, 1).slice(0, 2000));
  console.log("requests:", provider.requests.length);
}, 20000);
