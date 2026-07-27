import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSecretStore } from "./detect.js";

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "omniharness-detect-"));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("createSecretStore", () => {
  it("returns a working store in the current environment", async () => {
    const { store, backend } = await createSecretStore(dataDir);
    expect([
      "macos-keychain",
      "windows-credential",
      "linux-secret-tool",
      "encrypted-file",
    ]).toContain(backend);
    expect(store).toBeDefined();
    expect(typeof store.get).toBe("function");
  });

  it("falls back to the encrypted file store when no native binary exists", async () => {
    const { store, backend } = await createSecretStore(dataDir, { probe: async () => false });
    expect(backend).toBe("encrypted-file");
    // The fallback store is fully functional.
    await store.set("provider:openai:apiKey", "sk-fallback");
    expect(await store.get("provider:openai:apiKey")).toBe("sk-fallback");
    expect(await store.list()).toEqual(["provider:openai:apiKey"]);
    await store.delete("provider:openai:apiKey");
    expect(await store.get("provider:openai:apiKey")).toBeNull();
  });

  it("prefers the macOS keychain on darwin when `security` exists", async () => {
    const { backend } = await createSecretStore(dataDir, {
      platform: "darwin",
      probe: async (b) => b === "security",
    });
    expect(backend).toBe("macos-keychain");
  });

  it("prefers the Windows credential store on win32 when `cmdkey` exists", async () => {
    const { backend } = await createSecretStore(dataDir, {
      platform: "win32",
      probe: async (b) => b === "cmdkey",
    });
    expect(backend).toBe("windows-credential");
  });

  it("prefers secret-tool on linux when present", async () => {
    const { backend } = await createSecretStore(dataDir, {
      platform: "linux",
      probe: async (b) => b === "secret-tool",
    });
    expect(backend).toBe("linux-secret-tool");
  });

  it("falls back on linux when secret-tool is missing", async () => {
    const { backend } = await createSecretStore(dataDir, {
      platform: "linux",
      probe: async () => false,
    });
    expect(backend).toBe("encrypted-file");
  });
});
