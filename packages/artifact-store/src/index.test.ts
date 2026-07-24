import { describe, expect, it } from "vitest";
import { ArtifactStore } from "./index.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("ArtifactStore", () => {
  it("stores and resolves content-addressed artifacts", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "art-"));
    const store = new ArtifactStore(dir);
    const a = store.put("hello world");
    expect(a.uri).toMatch(/^artifact:\/\/[a-f0-9]{64}$/);
    expect(store.get(a.uri)?.toString()).toBe("hello world");
    // idempotent
    const b = store.put("hello world");
    expect(b.uri).toBe(a.uri);
    expect(store.get("artifact://nope")).toBeNull();
  });

  it("truncates oversized text with artifact reference", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "art-"));
    const store = new ArtifactStore(dir);
    const big = "x".repeat(1000);
    const r = store.truncateWithArtifact(big, 100);
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThan(250);
    expect(r.artifact).toBeDefined();
    expect(store.get(r.artifact!.uri)?.toString()).toBe(big);
    const small = store.truncateWithArtifact("short", 100);
    expect(small.truncated).toBe(false);
  });
});
