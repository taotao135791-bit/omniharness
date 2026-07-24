import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Workspace } from "@omniharness/shared-types";
import {
  assertReadable,
  assertWritable,
  detectKind,
  PathPolicyError,
  WorkspaceManager,
} from "./index.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "omniharness-ws-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("kind detection", () => {
  it("detects folder, git, monorepo and multi-root", async () => {
    expect(await detectKind([dir])).toBe("folder");

    await mkdir(join(dir, ".git"));
    expect(await detectKind([dir])).toBe("git");

    await writeFile(join(dir, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
    expect(await detectKind([dir])).toBe("monorepo");

    const other = await mkdtemp(join(tmpdir(), "omniharness-ws2-"));
    expect(await detectKind([dir, other])).toBe("multi-root");
    await rm(other, { recursive: true, force: true });
  });

  it("registers workspaces via WorkspaceManager", async () => {
    const mgr = new WorkspaceManager({ dataDir: join(dir, "data") });
    const ws = await mgr.register({
      name: "test",
      roots: [dir],
      protectedPaths: ["secrets/**"],
      readOnlyPaths: ["*.lock"],
    });
    expect(ws.kind).toBe("folder");
    expect(mgr.get(ws.id)).toEqual(ws);
    expect(mgr.list()).toHaveLength(1);
    expect(mgr.remove(ws.id)).toBe(true);
    expect(mgr.get(ws.id)).toBeUndefined();
  });
});

describe("path policy", () => {
  async function makeWorkspace(overrides?: Partial<Workspace>): Promise<Workspace> {
    const mgr = new WorkspaceManager({ dataDir: join(dir, "data") });
    return mgr.register({
      name: "t",
      roots: [join(dir, "root")],
      protectedPaths: ["secrets/**", ".env"],
      readOnlyPaths: ["*.lock", "vendor/"],
      ...overrides,
    });
  }

  beforeEach(async () => {
    await mkdir(join(dir, "root", "src"), { recursive: true });
    await mkdir(join(dir, "root", "secrets"), { recursive: true });
    await writeFile(join(dir, "root", "src", "a.ts"), "export {}\n");
    await writeFile(join(dir, "root", "secrets", "key.pem"), "KEY\n");
    await writeFile(join(dir, "root", "package.lock"), "lock\n");
  });

  it("allows ordinary writable paths and returns the resolved path", async () => {
    const ws = await makeWorkspace();
    const resolved = await assertWritable(ws, join(dir, "root", "src", "b.ts"));
    expect(resolved.endsWith(join("root", "src", "b.ts"))).toBe(true);
  });

  it("denies protected and read-only paths", async () => {
    const ws = await makeWorkspace();
    await expect(assertWritable(ws, join(dir, "root", "secrets", "key.pem"))).rejects.toMatchObject(
      { name: "PathPolicyError", reason: "protected" },
    );
    await expect(assertWritable(ws, join(dir, "root", "package.lock"))).rejects.toMatchObject({
      reason: "read-only",
    });
    await expect(assertWritable(ws, join(dir, "root", ".env"))).rejects.toMatchObject({
      reason: "protected",
    });
  });

  it("denies writes outside the workspace", async () => {
    const ws = await makeWorkspace();
    await expect(assertWritable(ws, join(dir, "outside.txt"))).rejects.toMatchObject({
      reason: "outside-workspace",
    });
  });

  it("blocks a symlink escape through an in-workspace link", async () => {
    const outside = join(dir, "outside-target");
    await mkdir(outside);
    await writeFile(join(outside, "victim.txt"), "precious\n");
    await symlink(outside, join(dir, "root", "link-out"), "dir");

    const ws = await makeWorkspace();
    // Writing through the symlink would land outside the root → must fail.
    await expect(assertWritable(ws, join(dir, "root", "link-out", "victim.txt"))).rejects.toBeInstanceOf(
      PathPolicyError,
    );

    // A symlink pointing INSIDE the workspace is fine.
    await symlink(join(dir, "root", "src"), join(dir, "root", "link-in"), "dir");
    await expect(assertWritable(ws, join(dir, "root", "link-in", "c.ts"))).resolves.toContain(
      join("root", "src"),
    );
  });

  it("allows reads outside the workspace but denies protected reads", async () => {
    const ws = await makeWorkspace();
    await writeFile(join(dir, "external.txt"), "ext\n");
    await expect(assertReadable(ws, join(dir, "external.txt"))).resolves.toContain("external.txt");
    await expect(assertReadable(ws, join(dir, "root", "secrets", "key.pem"))).rejects.toMatchObject(
      { reason: "protected" },
    );
    // Read-only only restricts writes, not reads.
    await expect(assertReadable(ws, join(dir, "root", "package.lock"))).resolves.toContain(
      "package.lock",
    );
  });
});
