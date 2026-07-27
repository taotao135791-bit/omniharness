import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OmniDatabase } from "@omniharness/session-store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { importInstructionFiles, mergeInstructionFiles } from "./instruction-files.js";
import { importMcpConfig } from "./mcp-config.js";
import { seedDb } from "./pi-session.test.js";
import { InMemorySecretStore } from "./secret-store.js";

let dir: string;
let db: OmniDatabase;
let secrets: InMemorySecretStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omni-mcp-instr-"));
  db = seedDb().db;
  secrets = new InMemorySecretStore();
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("importMcpConfig", () => {
  it("parses mcpServers into inert registration records", async () => {
    const path = join(dir, "mcp.json");
    writeFileSync(
      path,
      JSON.stringify({
        mcpServers: {
          filesystem: {
            command: "npx",
            args: ["-y", "@mcp/fs", "/data"],
            env: { LOG_LEVEL: "debug" },
          },
          github: { command: "mcp-github", env: { GITHUB_TOKEN: "ghp_secret", REGION: "us" } },
          broken: { args: [] },
        },
      }),
    );
    const report = await importMcpConfig(path, { db, secretStore: secrets });
    expect(report.servers).toHaveLength(2);
    expect(report.imported).toBe(2);
    expect(report.errors).toEqual([
      { id: "broken", message: 'server entry requires a non-empty "command"; skipped' },
    ]);

    const fs = report.servers.find((s) => s.name === "filesystem")!;
    expect(fs.command).toBe("npx");
    expect(fs.args).toEqual(["-y", "@mcp/fs", "/data"]);
    expect(fs.env).toEqual({ LOG_LEVEL: "debug" });

    // Secret-looking env values are stored as refs, not inline.
    const gh = report.servers.find((s) => s.name === "github")!;
    expect(gh.env).toEqual({ REGION: "us" });
    expect(gh.secretEnvRefs).toEqual({ GITHUB_TOKEN: "mcp:github:env:GITHUB_TOKEN" });
    expect(await secrets.get("mcp:github:env:GITHUB_TOKEN")).toBe("ghp_secret");

    // Persisted as data in the settings table; no secret inline.
    const stored = db.settings.get("global", "mcp", "server.github");
    expect(JSON.stringify(stored)).not.toContain("ghp_secret");
    expect(JSON.stringify(stored)).toContain("mcp:github:env:GITHUB_TOKEN");

    // Idempotent.
    const again = await importMcpConfig(path, { db, secretStore: secrets });
    expect(again.imported).toBe(0);
    expect(again.skipped).toHaveLength(2);
  });

  it("keeps secret env inline (with a warning) when no SecretStore is configured", async () => {
    const path = join(dir, "mcp.json");
    writeFileSync(
      path,
      JSON.stringify({ mcpServers: { a: { command: "x", env: { API_KEY: "k" } } } }),
    );
    const report = await importMcpConfig(path, { db });
    expect(report.servers[0]!.env).toEqual({ API_KEY: "k" });
    expect(report.warnings.some((w) => w.includes("API_KEY"))).toBe(true);
  });

  it("rejects non-mcpServers JSON", async () => {
    const path = join(dir, "mcp.json");
    writeFileSync(path, JSON.stringify({ other: true }));
    const report = await importMcpConfig(path, { db });
    expect(report.servers).toEqual([]);
    expect(report.errors[0]?.message).toContain("mcpServers");
  });
});

describe("importInstructionFiles", () => {
  it("merges CLAUDE.md → AGENTS.md → .pi/AGENTS.md → SYSTEM.md with provenance markers", () => {
    writeFileSync(join(dir, "SYSTEM.md"), "system rules");
    writeFileSync(join(dir, "AGENTS.md"), "agents rules");
    writeFileSync(join(dir, "CLAUDE.md"), "claude rules");
    mkdirSync(join(dir, ".pi"));
    writeFileSync(join(dir, ".pi", "AGENTS.md"), "pi overlay");

    const outputPath = join(dir, "out", "instructions.md");
    const report = importInstructionFiles({ workspaceRoot: dir, db, outputPath });
    expect(report.errors).toEqual([]);
    expect(report.files).toEqual(["CLAUDE.md", "AGENTS.md", ".pi/AGENTS.md", "SYSTEM.md"]);
    expect(report.imported).toBe(4);

    const merged = report.merged;
    // Order check: positions in the merged document.
    const positions = ["claude rules", "agents rules", "pi overlay", "system rules"].map((s) =>
      merged.indexOf(s),
    );
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    // Provenance markers per file.
    expect(merged).toContain('<!-- BEGIN omni:instructions source="CLAUDE.md" -->');
    expect(merged).toContain('<!-- END omni:instructions source=".pi/AGENTS.md" -->');
    // Written to outputPath with identical content.
    expect(readFileSync(outputPath, "utf8")).toBe(merged);
  });

  it("warns when no instruction files exist and imports nothing", () => {
    const report = importInstructionFiles({ workspaceRoot: dir, db });
    expect(report.imported).toBe(0);
    expect(report.warnings.some((w) => w.includes("no instruction files"))).toBe(true);
  });

  it("is idempotent and honors dry-run", () => {
    writeFileSync(join(dir, "AGENTS.md"), "rules");
    const outputPath = join(dir, "out.md");
    const first = importInstructionFiles({ workspaceRoot: dir, db, outputPath });
    expect(first.imported).toBe(1);
    const second = importInstructionFiles({ workspaceRoot: dir, db, outputPath });
    expect(second.imported).toBe(0);
    expect(second.skipped).toEqual([{ id: dir, reason: "already imported" }]);

    const dryDir = join(dir, "dry");
    mkdirSync(dryDir);
    writeFileSync(join(dryDir, "CLAUDE.md"), "x");
    const dryOut = join(dir, "dry-out.md");
    const dry = importInstructionFiles({
      workspaceRoot: dryDir,
      db,
      outputPath: dryOut,
      dryRun: true,
    });
    expect(dry.imported).toBe(1);
    expect(existsSync(dryOut)).toBe(false);
  });

  it("mergeInstructionFiles is a pure function of its input", () => {
    const merged = mergeInstructionFiles([
      { path: "CLAUDE.md", content: "a" },
      { path: "SYSTEM.md", content: "b" },
    ]);
    expect(merged.indexOf("a")).toBeLessThan(merged.indexOf("b"));
    expect(merged).toContain("CLAUDE.md → AGENTS.md → .pi/AGENTS.md → SYSTEM.md");
  });
});
