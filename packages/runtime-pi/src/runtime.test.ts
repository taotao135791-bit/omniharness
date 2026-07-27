import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FixtureProvider,
  fixture,
  ModelCapabilityRegistry,
  ModelRouter,
} from "@omniharness/model-gateway";
import type { FixtureResponse } from "@omniharness/model-gateway";
import { PolicyEngine } from "@omniharness/policy-engine";
import { createCoreTools, ok, ToolRegistry } from "@omniharness/tool-runtime";
import type { Tool } from "@omniharness/tool-runtime";
import {
  DEFAULT_CAPABILITIES,
  type ModelDefinition,
  type ModelId,
  type ProviderId,
  type SessionId,
  type Workspace,
  type WorkspaceId,
  type ProjectId,
} from "@omniharness/shared-types";
import { PiAgentRuntime } from "./index.js";
import type { RuntimeEvent } from "./index.js";

const SESSION = "ses_test" as SessionId;

function makeModelDef(id: string, contextWindow = 128_000): ModelDefinition {
  return {
    id: id as ModelId,
    providerId: "fixture" as ProviderId,
    remoteName: id,
    displayName: id,
    capabilities: { ...DEFAULT_CAPABILITIES, nativeToolCalling: true, contextWindow },
    enabled: true,
  };
}

interface Harness {
  runtime: PiAgentRuntime;
  provider: FixtureProvider;
  toolRegistry: ToolRegistry;
  policy: PolicyEngine;
  root: string;
}

function makeHarness(
  root: string,
  script: FixtureResponse[],
  options?: {
    contextWindow?: number;
    withSummarizer?: boolean;
    compaction?: { enabled: boolean; reserveTokens: number; keepRecentTokens: number };
  },
): Harness {
  const capabilityRegistry = new ModelCapabilityRegistry();
  capabilityRegistry.register(makeModelDef("fixture:main", options?.contextWindow));
  if (options?.withSummarizer) {
    capabilityRegistry.register(makeModelDef("fixture:summary", options?.contextWindow));
  }
  const provider = new FixtureProvider(script);
  const router = new ModelRouter({
    registry: capabilityRegistry,
    providers: new Map([["fixture", provider]]),
    bindings: {
      primary: "fixture:main" as ModelId,
      ...(options?.withSummarizer ? { summarizer: "fixture:summary" as ModelId } : {}),
    },
    sleep: () => Promise.resolve(),
    random: () => 0.5,
  });
  const toolRegistry = new ToolRegistry();
  toolRegistry.registerAll(createCoreTools());
  const policy = new PolicyEngine({ workspaceRoot: root });
  const workspace: Workspace = {
    id: "ws_test" as WorkspaceId,
    projectId: "proj_test" as ProjectId,
    name: "test",
    kind: "folder",
    roots: [root],
    protectedPaths: [],
    readOnlyPaths: [],
    createdAt: new Date().toISOString(),
  };
  const runtime = new PiAgentRuntime({
    router,
    registry: toolRegistry,
    policy,
    workspace,
    ...(options?.compaction !== undefined ? { compaction: options.compaction } : {}),
  });
  return { runtime, provider, toolRegistry, policy, root };
}

async function collect(events: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const out: RuntimeEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

function types(events: RuntimeEvent[]): string[] {
  return events.map((e) => e.type);
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "runtime-pi-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("PiAgentRuntime", () => {
  it("streams a plain text reply and reports usage on completion", async () => {
    const { runtime, provider } = makeHarness(root, [
      fixture.text(["Hello", " world"], {
        usage: { inputTokens: 12, outputTokens: 7, costUsd: 0.001 },
      }),
    ]);

    const events = await collect(
      runtime.startRun({
        sessionId: SESSION,
        input: "hi",
        attachments: [{ uri: "file:///a.png", mimeType: "image/png", name: "a.png" }],
      }),
    );

    expect(types(events)).toEqual([
      "run.started",
      "message.started",
      "message.attachment",
      "message.completed",
      "message.started",
      "message.delta",
      "message.delta",
      "message.completed",
      "run.completed",
    ]);
    const deltas = events.filter((e) => e.type === "message.delta");
    expect(deltas.map((d) => (d.type === "message.delta" ? d.delta : "")).join("")).toBe("Hello world");
    const completed = events.find((e) => e.type === "run.completed");
    expect(completed).toMatchObject({
      usage: { inputTokens: 12, outputTokens: 7, costUsd: 0.001 },
    });
    // The model request went through our router/gateway, not Pi providers.
    expect(provider.requests).toHaveLength(1);
    const request = provider.requests[0];
    expect(request?.messages[0]?.role).toBe("user");
    // Attachment reference is included as text for the model.
    const userText = JSON.stringify(request?.messages[0]?.parts);
    expect(userText).toContain("[Attachment a.png (image/png): file:///a.png]");
  });

  it("executes an fs.write tool call through ToolRuntime", async () => {
    const { runtime, provider, root: wsRoot } = makeHarness(root, [
      fixture.toolCall(
        "fs.write",
        JSON.stringify({ path: path.join(root, "note.txt"), content: "hello file" }),
        "call_write",
      ),
      fixture.text("file written", { usage: { inputTokens: 5, outputTokens: 2 } }),
    ]);

    const events = await collect(runtime.startRun({ sessionId: SESSION, input: "write a file" }));

    expect(types(events)).toContain("tool.call.started");
    expect(types(events)).toContain("tool.call.completed");
    const started = events.find((e) => e.type === "tool.call.started");
    expect(started).toMatchObject({ toolName: "fs.write", toolCallId: "call_write" });
    const completed = events.find((e) => e.type === "tool.call.completed");
    expect(completed).toBeDefined();
    // The file was actually written via our tool pipeline.
    expect(await readFile(path.join(wsRoot, "note.txt"), "utf8")).toBe("hello file");
    // Second model request carries the tool result back through the gateway.
    expect(provider.requests).toHaveLength(2);
    const second = provider.requests[1];
    const toolMessage = second?.messages.find((m) => m.role === "tool");
    expect(toolMessage?.parts[0]).toMatchObject({ type: "tool_result", toolCallId: "call_write" });
    expect(types(events)).toContain("run.completed");
  });

  it("emits tool.call.denied when policy denies shell.exec", async () => {
    const { runtime, provider, policy } = makeHarness(root, [
      fixture.toolCall("shell.exec", JSON.stringify({ command: "echo", args: ["hi"] }), "call_shell"),
      fixture.text("understood, I cannot run that"),
    ]);
    policy.addRule("product_default", { capability: "shell.exec", decision: "deny" });

    const events = await collect(runtime.startRun({ sessionId: SESSION, input: "run echo" }));

    const denied = events.find((e) => e.type === "tool.call.denied");
    expect(denied).toBeDefined();
    expect(denied).toMatchObject({ toolCallId: "call_shell" });
    expect(denied?.type === "tool.call.denied" && denied.reason).toContain("Policy denied shell.exec");
    expect(types(events)).not.toContain("tool.call.failed");
    // The denial is fed back to the model as an error tool result.
    const second = provider.requests[1];
    const toolMessage = second?.messages.find((m) => m.role === "tool");
    expect(toolMessage?.parts[0]).toMatchObject({ type: "tool_result", isError: true });
    expect(types(events)).toContain("run.completed");
  });

  it("injects steering input mid-run", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const barrier: Tool = {
      name: "test.barrier",
      description: "Blocks until released by the test",
      parametersSchema: { type: "object", properties: {}, additionalProperties: false },
      requiredCapabilities: [],
      async execute() {
        await gate;
        return ok("released");
      },
    };
    const { runtime, provider, toolRegistry } = makeHarness(root, [
      fixture.toolCall("test.barrier", "{}", "call_barrier"),
      fixture.text("steered reply"),
    ]);
    toolRegistry.register(barrier);

    const stream = runtime.startRun({ sessionId: SESSION, input: "start", runId: "run_steer" });
    const iterator = stream[Symbol.asyncIterator]();
    const events: RuntimeEvent[] = [];
    // Consume until the barrier tool is executing, then steer mid-run.
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      events.push(next.value);
      if (next.value.type === "tool.call.started") break;
    }
    expect(runtime.steer("run_steer", "please hurry up")).toBe(true);
    release();
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      events.push(next.value);
    }

    expect(types(events)).toContain("run.steered");
    expect(types(events)).toContain("run.completed");
    // The steering message reached the model on the next turn.
    expect(provider.requests).toHaveLength(2);
    const second = provider.requests[1];
    const steering = second?.messages.find(
      (m) => m.role === "user" && JSON.stringify(m.parts).includes("please hurry up"),
    );
    expect(steering).toBeDefined();
  });

  it("interrupts a run cleanly", async () => {
    const slow: Tool = {
      name: "test.slow",
      description: "Hangs until aborted",
      parametersSchema: { type: "object", properties: {}, additionalProperties: false },
      requiredCapabilities: [],
      execute: (_args, ctx) =>
        new Promise((_, reject) => {
          ctx.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    };
    const { runtime, toolRegistry } = makeHarness(root, [
      fixture.toolCall("test.slow", "{}", "call_slow"),
    ]);
    toolRegistry.register(slow);

    const stream = runtime.startRun({ sessionId: SESSION, input: "run slow tool", runId: "run_int" });
    const iterator = stream[Symbol.asyncIterator]();
    const events: RuntimeEvent[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      events.push(next.value);
      if (next.value.type === "tool.call.started") break;
    }
    expect(runtime.interrupt("run_int")).toBe(true);
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      events.push(next.value);
    }

    const failed = events.find((e) => e.type === "run.failed");
    expect(failed).toBeDefined();
    expect(failed?.type === "run.failed" && failed.error).toBe("Run interrupted");
    expect(types(events)).not.toContain("run.completed");
    // The session is usable again afterwards.
    expect(runtime.hasActiveRun(SESSION)).toBe(false);
  });

  it("compacts over-threshold context via the summarizer role and emits events", async () => {
    const longText = "x".repeat(4000);
    const { runtime, provider } = makeHarness(
      root,
      [
        // Run 1: long primary reply with heavy reported usage.
        fixture.text(longText, { usage: { inputTokens: 500, outputTokens: 250 } }),
        // Run 2: summarizer call, then the primary reply on the compacted context.
        fixture.text("SUMMARY: user said hi; assistant produced a long document."),
        fixture.text("final answer"),
      ],
      {
        contextWindow: 400,
        withSummarizer: true,
        compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 60 },
      },
    );

    const run1 = await collect(runtime.startRun({ sessionId: SESSION, input: "hi" }));
    expect(types(run1)).toContain("run.completed");

    const run2 = await collect(runtime.startRun({ sessionId: SESSION, input: "again" }));
    const compacting = run2.find((e) => e.type === "run.compacting");
    const compacted = run2.find((e) => e.type === "run.compacted");
    expect(compacting).toBeDefined();
    expect(compacted).toBeDefined();
    expect(types(run2)).toContain("run.completed");

    // Three model calls total: primary (run 1), summarizer, primary (run 2).
    expect(provider.requests).toHaveLength(3);
    // The final primary request starts from the compacted context.
    const finalRequest = provider.requests[2];
    const firstMessage = finalRequest?.messages[0];
    expect(firstMessage?.role).toBe("user");
    expect(JSON.stringify(firstMessage?.parts)).toContain("[Summary of earlier conversation]");
    expect(JSON.stringify(firstMessage?.parts)).toContain("SUMMARY: user said hi");
    // Compaction is persisted into the session transcript.
    const transcript = runtime.transcript(SESSION);
    expect(transcript.length).toBeLessThan(4);
    const first = transcript[0];
    expect(first?.role).toBe("user");
    expect(JSON.stringify(first)).toContain("[Summary of earlier conversation]");
  });
});
