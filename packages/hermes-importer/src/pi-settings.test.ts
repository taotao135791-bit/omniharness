import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OmniDatabase } from "@omniharness/session-store";
import type { ProviderId } from "@omniharness/shared-types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { importPiSettings } from "./pi-settings.js";
import { InMemorySecretStore } from "./secret-store.js";
import { seedDb } from "./pi-session.test.js";

let dir: string;
let agentDir: string;
let dataDir: string;
let db: OmniDatabase;
let secrets: InMemorySecretStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omni-pi-settings-"));
  agentDir = join(dir, "agent");
  dataDir = join(dir, "omni-data");
  mkdirSync(agentDir, { recursive: true });
  db = seedDb().db;
  secrets = new InMemorySecretStore();
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function baseOptions() {
  return { agentDir, dataDir, db, secretStore: secrets };
}

describe("importPiSettings — settings.json", () => {
  it("maps known keys and reports unmapped ones", async () => {
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({
        defaultModel: "anthropic/claude-opus",
        theme: "dark",
        externalEditor: "vim",
        enableAnalytics: true,
        retry: { maxRetries: 5, enabled: true },
        someUnknownFlag: true,
        defaultThinkingLevel: "high",
      }),
    );
    const report = await importPiSettings(baseOptions());
    expect(report.errors).toEqual([]);
    expect(db.settings.get("global", "global", "models.defaultModelId")).toBe("anthropic/claude-opus");
    expect(db.settings.get("global", "global", "tui.theme")).toBe("dark");
    expect(db.settings.get("global", "global", "tui.editorCommand")).toBe("vim");
    expect(db.settings.get("global", "global", "telemetry.anonymousUsage")).toBe(true);
    expect(db.settings.get("global", "global", "models.maxRetries")).toBe(5);
    expect(report.unmappedKeys).toContain("someUnknownFlag");
    expect(report.unmappedKeys).toContain("defaultThinkingLevel");
    expect(report.unmappedKeys).toContain("retry.enabled");
    expect(report.unmappedKeys).not.toContain("defaultModel");
  });

  it("skips values incompatible with the target field", async () => {
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "solarized-neon" }));
    const report = await importPiSettings(baseOptions());
    expect(db.settings.get("global", "global", "tui.theme")).toBeUndefined();
    expect(report.skipped).toEqual([{ id: "theme", reason: "value incompatible with tui.theme" }]);
  });

  it("reports mapped targets missing from an injected schemaKeys list", async () => {
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "dark" }));
    const report = await importPiSettings({ ...baseOptions(), schemaKeys: ["models.defaultModelId"] });
    expect(report.errors).toEqual([
      { id: "theme", message: 'mapped target "tui.theme" is not in the settings schema' },
    ]);
    expect(db.settings.get("global", "global", "tui.theme")).toBeUndefined();
  });
});

describe("importPiSettings — resources", () => {
  it("copies skills/prompts/themes with a provenance marker", async () => {
    mkdirSync(join(agentDir, "skills", "demo"), { recursive: true });
    writeFileSync(join(agentDir, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: d\n---\nbody\n");
    mkdirSync(join(agentDir, "prompts"), { recursive: true });
    writeFileSync(join(agentDir, "prompts", "review.md"), "review this");
    mkdirSync(join(agentDir, "themes"), { recursive: true });
    writeFileSync(join(agentDir, "themes", "dark.json"), "{}");

    const report = await importPiSettings(baseOptions());
    expect(report.filesCopied).toBe(3);
    const skillDest = join(dataDir, "pi", "global", "skills", "demo", "SKILL.md");
    expect(existsSync(skillDest)).toBe(true);
    const provenance = JSON.parse(
      readFileSync(join(dataDir, "pi", "global", "skills", "_omni-provenance.json"), "utf8"),
    ) as { provenance: string; source: string };
    expect(provenance.provenance).toBe("imported");
    expect(provenance.source).toBe("pi");

    // Idempotent re-import.
    const again = await importPiSettings(baseOptions());
    expect(again.filesCopied).toBe(0);
    expect(again.skipped.some((s) => s.reason === "already imported")).toBe(true);
  });
});

describe("importPiSettings — models.json + auth.json", () => {
  it("imports providers/models and stores literal apiKeys in the SecretStore only", async () => {
    writeFileSync(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          acme: {
            name: "Acme",
            baseUrl: "https://api.acme.test",
            api: "openai-completions",
            apiKey: "sk-literal-secret",
            models: [
              { id: "acme-1", name: "Acme One", reasoning: true, input: ["text", "image"], contextWindow: 100000, maxTokens: 8000, cost: { input: 2, output: 8, cacheRead: 0, cacheWrite: 0 } },
            ],
          },
        },
      }),
    );
    const report = await importPiSettings(baseOptions());
    expect(report.errors).toEqual([]);

    const provider = db.providers.get("prov_pi_acme" as ProviderId);
    expect(provider).toBeDefined();
    expect(provider!.kind).toBe("openai");
    expect(provider!.baseUrl).toBe("https://api.acme.test");
    // Only the ref lands in the DB — never the secret itself.
    expect(provider!.apiKeyRef).toBe("provider:prov_pi_acme:apiKey");
    expect(await secrets.get("provider:prov_pi_acme:apiKey")).toBe("sk-literal-secret");

    const models = db.models.listByProvider("prov_pi_acme" as ProviderId);
    expect(models).toHaveLength(1);
    expect(models[0]!.remoteName).toBe("acme-1");
    expect(models[0]!.capabilities.vision).toBe(true);
    expect(models[0]!.capabilities.reasoningControl).toBe(true);
    expect(models[0]!.capabilities.contextWindow).toBe(100000);
    expect(models[0]!.costPerMInputTokens).toBe(2);
    expect(report.secretsStored).toBe(1);
  });

  it("auth.json secrets land in the SecretStore, never in output JSON", async () => {
    writeFileSync(
      join(agentDir, "auth.json"),
      JSON.stringify({
        anthropic: { type: "api_key", key: "sk-ant-secret", env: { ACME_ACCOUNT: "acct-1" } },
        openai: { type: "oauth", refresh: "r", access: "a", expires: 123 },
      }),
    );
    const report = await importPiSettings(baseOptions());
    expect(report.errors).toEqual([]);
    expect(report.secretsStored).toBe(3);
    expect(await secrets.get("pi:auth:anthropic:apiKey")).toBe("sk-ant-secret");
    expect(await secrets.get("pi:auth:anthropic:env:ACME_ACCOUNT")).toBe("acct-1");
    const oauth = await secrets.get("pi:auth:openai:oauth");
    expect(oauth).not.toBeNull();
    expect(JSON.parse(oauth!)).toMatchObject({ type: "oauth", refresh: "r" });

    // No secret string appears anywhere in the settings table.
    const allSettings = db.settings.list("global", "global");
    expect(JSON.stringify(allSettings)).not.toContain("sk-ant-secret");

    // Idempotent.
    const again = await importPiSettings(baseOptions());
    expect(again.imported).toBe(0);
    expect(again.skipped).toHaveLength(2);
  });

  it("skips auth.json credentials when no SecretStore is configured", async () => {
    writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "k" } }));
    const report = await importPiSettings({ agentDir, dataDir, db });
    expect(report.secretsStored).toBe(0);
    expect(report.skipped).toEqual([
      { id: "auth:anthropic", reason: "no SecretStore configured; secrets not imported" },
    ]);
  });
});
