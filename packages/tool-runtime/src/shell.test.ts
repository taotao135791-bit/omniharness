import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "@omniharness/shared-types";
import {
  createShellExecTool,
  LocalShellExecutor,
} from "./index.js";
import type { SandboxExecutor, ToolContext, ToolOutputChunk } from "./index.js";

let dir: string;
let ctx: ToolContext;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "omniharness-shell-"));
  const workspace: Workspace = {
    id: "ws_s" as Workspace["id"],
    projectId: "prj_s" as Workspace["projectId"],
    name: "s",
    kind: "folder",
    roots: [dir],
    protectedPaths: [],
    readOnlyPaths: [],
    createdAt: new Date().toISOString(),
  };
  ctx = {
    workspace,
    sessionId: "s",
    agentId: "a",
    signal: new AbortController().signal,
    emit: () => undefined,
  };
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("LocalShellExecutor", () => {
  it("captures stdout/stderr, exit code and duration", async () => {
    const executor = new LocalShellExecutor();
    const result = await executor.exec({
      command: "node",
      args: ["-e", "process.stdout.write('out');process.stderr.write('err');process.exit(3)"],
      cwd: dir,
      timeoutMs: 5000,
      signal: ctx.signal,
    });
    expect(result.stdout).toBe("out");
    expect(result.stderr).toBe("err");
    expect(result.exitCode).toBe(3);
    expect(result.timedOut).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("enforces the timeout by killing the process", async () => {
    const executor = new LocalShellExecutor();
    const started = Date.now();
    const result = await executor.exec({
      command: "node",
      args: ["-e", "setTimeout(() => {}, 60_000)"],
      cwd: dir,
      timeoutMs: 150,
      signal: ctx.signal,
    });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.exitCode).not.toBe(0);
  });
});

describe("shell.exec tool", () => {
  it("streams output chunks via ctx.emit", async () => {
    const tool = createShellExecTool();
    const chunks: ToolOutputChunk[] = [];
    const streamingCtx: ToolContext = { ...ctx, emit: (c) => chunks.push(c) };
    const res = await tool.execute(
      { command: "node", args: ["-e", "process.stdout.write('hello-stream')"] },
      streamingCtx,
    );
    expect(res.ok).toBe(true);
    expect(res.output).toContain("hello-stream");
    expect(chunks.map((c) => c.text).join("")).toContain("hello-stream");
  });

  it("marks non-zero exits as errors", async () => {
    const tool = createShellExecTool();
    const res = await tool.execute({ command: "node", args: ["-e", "process.exit(2)"] }, ctx);
    expect(res.ok).toBe(false);
    expect(res.isError).toBe(true);
    expect(res.output).toContain("exit code 2");
  });

  it("enforces timeout_ms", async () => {
    const tool = createShellExecTool();
    const res = await tool.execute(
      { command: "node", args: ["-e", "setTimeout(() => {}, 60_000)"], timeout_ms: 150 },
      ctx,
    );
    expect(res.ok).toBe(false);
    expect(res.output).toContain("timed out");
  });

  it("uses the injected SandboxExecutor instead of spawning", async () => {
    const exec = vi.fn(async () => ({
      exitCode: 0,
      stdout: "from sandbox",
      stderr: "",
      durationMs: 1,
      timedOut: false,
    }));
    const sandbox: SandboxExecutor = { exec };
    const tool = createShellExecTool(sandbox);
    const res = await tool.execute({ command: "anything", args: ["--x"] }, ctx);
    expect(res.ok).toBe(true);
    expect(res.output).toBe("from sandbox");
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0]![0].command).toBe("anything");
    expect(exec.mock.calls[0]![0].args).toEqual(["--x"]);
  });
});
