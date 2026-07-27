import { describe, expect, it } from "vitest";
import { SandboxEngine } from "./engine.js";
import { NULL_BACKEND_WARNING, NullBackend } from "./backends/null.js";
import type { SandboxBackend, SandboxRequest, WrappedCommand } from "./types.js";

function fakeBackend(name: string, available: boolean): SandboxBackend {
  return {
    name,
    isAvailable: () => Promise.resolve(available),
    wrap: (cmd: SandboxRequest): WrappedCommand => ({
      argv: cmd.argv,
      env: cmd.env,
      backend: name,
      warnings: [],
    }),
  };
}

function runReq(overrides: Partial<SandboxRequest> = {}): SandboxRequest {
  return {
    argv: ["echo", "hello"],
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? "/usr/bin" },
    limits: { timeoutMs: 5000 },
    network: "off",
    writablePaths: [process.cwd()],
    ...overrides,
  };
}

describe("SandboxEngine backend selection", () => {
  it("auto picks the first available backend in order", async () => {
    const engine = new SandboxEngine({
      backends: [
        fakeBackend("seatbelt", false),
        fakeBackend("bwrap", true),
        fakeBackend("docker", true),
      ],
    });
    const backend = await engine.selectBackend();
    expect(backend.name).toBe("bwrap");

    const diag = engine.diagnostics();
    expect(diag.selectedBackend).toBe("bwrap");
    expect(diag.probes).toEqual([
      { backend: "seatbelt", available: false },
      { backend: "bwrap", available: true },
    ]);
  });

  it("auto falls back to null when nothing is available", async () => {
    const engine = new SandboxEngine({
      backends: [fakeBackend("seatbelt", false), new NullBackend()],
    });
    const backend = await engine.selectBackend();
    expect(backend.name).toBe("null");

    const diag = engine.diagnostics();
    expect(diag.selectedBackend).toBe("null");
    expect(diag.probes).toEqual([
      { backend: "seatbelt", available: false },
      { backend: "null", available: true, detail: "fallback: no isolating backend available" },
    ]);
    expect(diag.warnings.some((w) => w.includes("no isolation"))).toBe(true);
  });

  it("uses a named backend directly and throws when unavailable", async () => {
    const ok = new SandboxEngine({
      backend: "bwrap",
      backends: [fakeBackend("bwrap", true)],
    });
    expect((await ok.selectBackend()).name).toBe("bwrap");

    const missing = new SandboxEngine({
      backend: "seatbelt",
      backends: [fakeBackend("seatbelt", false)],
    });
    await expect(missing.selectBackend()).rejects.toThrow(/not available/);
    expect(missing.diagnostics().probes).toEqual([{ backend: "seatbelt", available: false }]);
  });

  it("records probe errors in diagnostics", async () => {
    const broken: SandboxBackend = {
      name: "seatbelt",
      isAvailable: () => Promise.reject(new Error("probe exploded")),
      wrap: (cmd) => ({ argv: cmd.argv, env: cmd.env, backend: "seatbelt", warnings: [] }),
    };
    const engine = new SandboxEngine({ backends: [broken, new NullBackend()] });
    expect((await engine.selectBackend()).name).toBe("null");
    expect(engine.diagnostics().probes[0]).toEqual({
      backend: "seatbelt",
      available: false,
      detail: "probe exploded",
    });
  });
});

describe("SandboxEngine.run", () => {
  it("executes via the null backend and captures stdout", async () => {
    const engine = new SandboxEngine({ backend: "null" });
    const result = await engine.run(runReq());
    expect(result.backend).toBe("null");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello");
    expect(result.warnings).toContain(NULL_BACKEND_WARNING);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("strips secret env vars and reports the count", async () => {
    const engine = new SandboxEngine({ backend: "null" });
    const result = await engine.run(
      runReq({
        argv: ["/bin/sh", "-c", 'echo "token=${API_TOKEN:-unset} path=$PATH"'],
        env: { PATH: process.env.PATH ?? "/usr/bin", API_TOKEN: "supersecret" },
      }),
    );
    expect(result.stdout).toContain("token=unset");
    expect(result.stdout).not.toContain("supersecret");
    expect(engine.diagnostics().strippedEnvCount).toBe(1);
  });

  it("kills the process on timeout with a warning", async () => {
    const engine = new SandboxEngine({ backend: "null" });
    const result = await engine.run(
      runReq({
        argv: ["/bin/sh", "-c", "sleep 5"],
        limits: { timeoutMs: 200 },
      }),
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.warnings.some((w) => w.includes("SIGKILL"))).toBe(true);
    expect(result.durationMs).toBeLessThan(5000);
  }, 10000);
});
