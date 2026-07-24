import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PolicyDecisionKind, Workspace } from "@omniharness/shared-types";
import {
  LocalArtifactStore,
  ToolRegistry,
  ToolRuntime,
} from "./index.js";
import type {
  AuditEntry,
  PolicyEvaluator,
  Tool,
  ToolRunContext,
} from "./index.js";

let dir: string;
let workspace: Workspace;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "omniharness-rt-"));
  workspace = {
    id: "ws_test" as Workspace["id"],
    projectId: "prj_test" as Workspace["projectId"],
    name: "test",
    kind: "folder",
    roots: [dir],
    protectedPaths: [],
    readOnlyPaths: [],
    createdAt: new Date().toISOString(),
  };
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function runCtx(): ToolRunContext {
  return { workspace, sessionId: "s1", agentId: "a1" };
}

function evaluator(decision: PolicyDecisionKind): PolicyEvaluator & { evaluate: ReturnType<typeof vi.fn> } {
  return {
    evaluate: vi.fn(() => ({
      decision,
      risk: "low" as const,
      matchedScope: "product_default" as const,
      reason: `rule says ${decision}`,
    })),
  };
}

function echoTool(name = "t.echo"): Tool & { execute: ReturnType<typeof vi.fn> } {
  return {
    name,
    description: "echoes",
    parametersSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
    requiredCapabilities: ["fs.read"],
    execute: vi.fn(async (args: Record<string, unknown>) => ({ ok: true, output: String(args["text"]) })),
  };
}

describe("ToolRuntime pipeline", () => {
  it("runs stages in order: validate → policy → approval → execute → sanitize → audit", async () => {
    const order: string[] = [];
    const tool = echoTool();
    tool.execute = vi.fn(async () => {
      order.push("execute");
      return { ok: true, output: "x".repeat(100) };
    });
    const registry = new ToolRegistry();
    registry.register(tool);

    const audits: AuditEntry[] = [];
    const artifactStore = new LocalArtifactStore(join(dir, "artifacts"));
    const origPut = artifactStore.put.bind(artifactStore);
    artifactStore.put = async (input) => {
      order.push("sanitize");
      return origPut(input);
    };

    const runtime = new ToolRuntime(registry, {
      policy: {
        evaluate: () => {
          order.push("policy");
          return { decision: "ask_every_time", risk: "low", matchedScope: "product_default", reason: "r" };
        },
      },
      approval: {
        request: async () => {
          order.push("approval");
          return { approved: true };
        },
      },
      artifactStore,
      maxOutputChars: 50,
      onAudit: (e) => {
        order.push("audit");
        audits.push(e);
      },
    });

    const result = await runtime.run("t.echo", { text: "hi" }, runCtx());
    expect(result.ok).toBe(true);
    expect(order).toEqual(["policy", "approval", "execute", "sanitize", "audit"]);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.outcome).toBe("executed");
    // Validation happens before policy; it passed silently. Prove it ran by failing next:
    order.length = 0;
    const bad = await runtime.run("t.echo", { wrong: 1 }, runCtx());
    expect(bad.ok).toBe(false);
    expect(order).toEqual(["audit"]); // only audit runs after failed validation
    expect(audits[1]!.outcome).toBe("validation_failed");
  });

  it("validation failure blocks execution", async () => {
    const tool = echoTool();
    const registry = new ToolRegistry();
    registry.register(tool);
    const runtime = new ToolRuntime(registry, { policy: evaluator("always_allow") });

    const result = await runtime.run("t.echo", {}, runCtx());
    expect(result.ok).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("missing required property");
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it("policy deny blocks execution", async () => {
    const tool = echoTool();
    const registry = new ToolRegistry();
    registry.register(tool);
    const audits: AuditEntry[] = [];
    const runtime = new ToolRuntime(registry, {
      policy: evaluator("deny"),
      onAudit: (e) => {
        audits.push(e);
      },
    });

    const result = await runtime.run("t.echo", { text: "hi" }, runCtx());
    expect(result.ok).toBe(false);
    expect(result.output).toContain("Policy denied");
    expect(tool.execute).not.toHaveBeenCalled();
    expect(audits[0]!.outcome).toBe("policy_denied");
  });

  it("approval denial blocks execution; approval grant allows it", async () => {
    const tool = echoTool();
    const registry = new ToolRegistry();
    registry.register(tool);
    const policy = evaluator("ask_every_time");

    const denyRuntime = new ToolRuntime(registry, {
      policy,
      approval: { request: async () => ({ approved: false, reason: "no way" }) },
    });
    const denied = await denyRuntime.run("t.echo", { text: "hi" }, runCtx());
    expect(denied.ok).toBe(false);
    expect(denied.output).toContain("no way");
    expect(tool.execute).not.toHaveBeenCalled();

    const allowRuntime = new ToolRuntime(registry, {
      policy,
      approval: { request: async () => ({ approved: true }) },
    });
    const allowed = await allowRuntime.run("t.echo", { text: "hi" }, runCtx());
    expect(allowed.ok).toBe(true);
    expect(tool.execute).toHaveBeenCalledTimes(1);
  });

  it("ask_once_per_session is requested only once per session", async () => {
    const tool = echoTool();
    const registry = new ToolRegistry();
    registry.register(tool);
    const request = vi.fn(async () => ({ approved: true }));
    const runtime = new ToolRuntime(registry, {
      policy: evaluator("ask_once_per_session"),
      approval: { request },
    });

    await runtime.run("t.echo", { text: "1" }, runCtx());
    await runtime.run("t.echo", { text: "2" }, runCtx());
    expect(request).toHaveBeenCalledTimes(1);
    expect(tool.execute).toHaveBeenCalledTimes(2);

    // A different session asks again.
    await runtime.run("t.echo", { text: "3" }, { ...runCtx(), sessionId: "s2" });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("ask decisions are denied without an approval gate", async () => {
    const tool = echoTool();
    const registry = new ToolRegistry();
    registry.register(tool);
    const runtime = new ToolRuntime(registry, { policy: evaluator("ask_every_time") });
    const result = await runtime.run("t.echo", { text: "hi" }, runCtx());
    expect(result.ok).toBe(false);
    expect(result.output).toContain("no approval gate");
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it("truncates long output and spills the remainder to an artifact", async () => {
    const tool: Tool = {
      name: "t.big",
      description: "big output",
      parametersSchema: { type: "object" },
      requiredCapabilities: ["fs.read"],
      async execute() {
        return { ok: true, output: "ABCDEFGH".repeat(100) }; // 800 chars
      },
    };
    const registry = new ToolRegistry();
    registry.register(tool);
    const artifactStore = new LocalArtifactStore(join(dir, "artifacts"));
    const runtime = new ToolRuntime(registry, {
      policy: evaluator("always_allow"),
      artifactStore,
      maxOutputChars: 100,
    });

    const result = await runtime.run("t.big", {}, runCtx());
    expect(result.ok).toBe(true);
    expect(result.artifact).toBeDefined();
    expect(result.artifact!.sizeBytes).toBe(700);
    expect(result.output.length).toBeLessThan(200);
    expect(result.output).toContain("truncated");
  });

  it("consumes async-iterable tools and forwards chunks to emit", async () => {
    const tool: Tool = {
      name: "t.stream",
      description: "streams",
      parametersSchema: { type: "object" },
      requiredCapabilities: ["fs.read"],
      async *execute() {
        yield { stream: "stdout" as const, text: "one " };
        yield { stream: "stdout" as const, text: "two" };
      },
    };
    const registry = new ToolRegistry();
    registry.register(tool);
    const runtime = new ToolRuntime(registry, { policy: evaluator("always_allow") });

    const chunks: string[] = [];
    const result = await runtime.run("t.stream", {}, { ...runCtx(), emit: (c) => chunks.push(c.text) });
    expect(result.ok).toBe(true);
    expect(result.output).toBe("one two");
    expect(chunks).toEqual(["one ", "two"]);
  });

  it("times out a tool that ignores the abort signal and never executes late stages", async () => {
    const tool: Tool = {
      name: "t.hang",
      description: "hangs",
      parametersSchema: { type: "object" },
      requiredCapabilities: ["fs.read"],
      execute: () => new Promise(() => undefined), // never settles
    };
    const registry = new ToolRegistry();
    registry.register(tool);
    const audits: AuditEntry[] = [];
    const runtime = new ToolRuntime(registry, {
      policy: evaluator("always_allow"),
      onAudit: (e) => {
        audits.push(e);
      },
    });

    const result = await runtime.run("t.hang", {}, runCtx(), { timeoutMs: 50 });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("timed out");
    expect(audits[0]!.outcome).toBe("timed_out");
  });

  it("returns an error result when the tool throws", async () => {
    const tool: Tool = {
      name: "t.boom",
      description: "throws",
      parametersSchema: { type: "object" },
      requiredCapabilities: ["fs.read"],
      async execute() {
        throw new Error("kaboom");
      },
    };
    const registry = new ToolRegistry();
    registry.register(tool);
    const runtime = new ToolRuntime(registry, { policy: evaluator("always_allow") });
    const result = await runtime.run("t.boom", {}, runCtx());
    expect(result.ok).toBe(false);
    expect(result.output).toContain("kaboom");
  });

  it("reports unknown tools", async () => {
    const runtime = new ToolRuntime(new ToolRegistry(), { policy: evaluator("always_allow") });
    const result = await runtime.run("nope", {}, runCtx());
    expect(result.ok).toBe(false);
    expect(result.output).toContain("Unknown tool");
  });
});
