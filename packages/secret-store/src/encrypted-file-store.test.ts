import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EncryptedFileStore } from "./encrypted-file-store.js";
import { SecretStoreError } from "./store.js";

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "omniharness-secrets-"));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("EncryptedFileStore", () => {
  it("round-trips a secret", async () => {
    const store = new EncryptedFileStore(dataDir);
    await store.set("provider:openai:apiKey", "sk-test-123");
    expect(await store.get("provider:openai:apiKey")).toBe("sk-test-123");
  });

  it("returns null for unknown refs", async () => {
    const store = new EncryptedFileStore(dataDir);
    expect(await store.get("provider:nope:apiKey")).toBeNull();
  });

  it("persists across store instances", async () => {
    await new EncryptedFileStore(dataDir).set("provider:anthropic:apiKey", "sk-ant-xyz");
    const reopened = new EncryptedFileStore(dataDir);
    expect(await reopened.get("provider:anthropic:apiKey")).toBe("sk-ant-xyz");
  });

  it("never writes the plaintext secret to disk", async () => {
    const store = new EncryptedFileStore(dataDir);
    await store.set("provider:openai:apiKey", "sk-super-secret-value");
    const raw = await readFile(store.filePath, "utf8");
    expect(raw).not.toContain("sk-super-secret-value");
    expect(JSON.parse(raw)).toMatchObject({ version: 1 });
  });

  it("writes the vault file with mode 0600", async () => {
    const store = new EncryptedFileStore(dataDir);
    await store.set("provider:openai:apiKey", "sk-test-123");
    const mode = (await stat(store.filePath)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("detects tampering: flipping a byte fails GCM auth", async () => {
    const store = new EncryptedFileStore(dataDir);
    await store.set("provider:openai:apiKey", "sk-test-123");
    const vault = JSON.parse(await readFile(store.filePath, "utf8")) as {
      entries: Record<string, { data: string }>;
    };
    const entry = vault.entries["provider:openai:apiKey"];
    expect(entry).toBeDefined();
    if (entry === undefined) throw new Error("unreachable");
    // Flip the first character of the ciphertext.
    const first = entry.data[0] ?? "A";
    entry.data = (first === "A" ? "B" : "A") + entry.data.slice(1);
    await writeFile(store.filePath, JSON.stringify(vault), "utf8");

    const fresh = new EncryptedFileStore(dataDir);
    await expect(fresh.get("provider:openai:apiKey")).rejects.toThrow(SecretStoreError);
    await expect(fresh.get("provider:openai:apiKey")).rejects.toThrow(/tampered|decrypt/i);
  });

  it("fails to decrypt with a key derived from a different dataDir", async () => {
    await new EncryptedFileStore(dataDir).set("provider:openai:apiKey", "sk-test-123");
    // Same file, but a store whose key derivation material differs.
    const alien = new EncryptedFileStore(join(dataDir, "elsewhere"), "ignored.json");
    (alien as unknown as { filePath: string }).filePath = join(dataDir, "secrets.vault.json");
    await expect(alien.get("provider:openai:apiKey")).rejects.toThrow(SecretStoreError);
  });

  it("lists refs sorted", async () => {
    const store = new EncryptedFileStore(dataDir);
    await store.set("provider:zhipu:apiKey", "z");
    await store.set("provider:deepseek:apiKey", "d");
    await store.set("provider:openai:apiKey", "o");
    expect(await store.list()).toEqual([
      "provider:deepseek:apiKey",
      "provider:openai:apiKey",
      "provider:zhipu:apiKey",
    ]);
  });

  it("deletes secrets and tolerates deleting missing refs", async () => {
    const store = new EncryptedFileStore(dataDir);
    await store.set("provider:openai:apiKey", "sk-test-123");
    await store.delete("provider:openai:apiKey");
    expect(await store.get("provider:openai:apiKey")).toBeNull();
    expect(await store.list()).toEqual([]);
    await expect(store.delete("provider:openai:apiKey")).resolves.toBeUndefined();
  });

  it("overwrites existing refs", async () => {
    const store = new EncryptedFileStore(dataDir);
    await store.set("provider:openai:apiKey", "old");
    await store.set("provider:openai:apiKey", "new");
    expect(await store.get("provider:openai:apiKey")).toBe("new");
    expect(await store.list()).toEqual(["provider:openai:apiKey"]);
  });
});
