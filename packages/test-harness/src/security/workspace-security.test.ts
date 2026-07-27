import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkspaceManager, assertWritable } from "@omniharness/workspace-manager";
import type { Workspace } from "@omniharness/shared-types";

/**
 * Security test: filesystem boundary enforcement — path traversal and
 * symlink escape must fail.
 */
describe("workspace boundary security", () => {
  async function setup(): Promise<{ root: string; workspace: Workspace }> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sec-ws-"));
    fs.writeFileSync(path.join(root, "file.txt"), "hello");
    fs.mkdirSync(path.join(root, "src"));
    const manager = new WorkspaceManager({
      dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "sec-data-")),
    });
    const workspace = await manager.register({ roots: [root], name: "sec" });
    return { root, workspace };
  }

  it("blocks path traversal outside the workspace", async () => {
    const { root, workspace } = await setup();
    await expect(assertWritable(workspace, path.join(root, "..", "evil.txt"))).rejects.toThrow();
    await expect(assertWritable(workspace, "/etc/passwd")).rejects.toThrow();
  });

  it("blocks symlink escape", async () => {
    const { root, workspace } = await setup();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "sec-outside-"));
    fs.writeFileSync(path.join(outside, "secret.txt"), "top secret");
    fs.symlinkSync(outside, path.join(root, "link-out"));
    await expect(
      assertWritable(workspace, path.join(root, "link-out", "secret.txt")),
    ).rejects.toThrow();
  });

  it("honors protected and read-only paths", async () => {
    const { root, workspace } = await setup();
    workspace.protectedPaths.push("**/.git/**", "*.key");
    workspace.readOnlyPaths.push("src/**");
    await expect(assertWritable(workspace, path.join(root, ".git", "config"))).rejects.toThrow();
    await expect(assertWritable(workspace, path.join(root, "id.key"))).rejects.toThrow();
    await expect(assertWritable(workspace, path.join(root, "src", "a.ts"))).rejects.toThrow();
    await expect(assertWritable(workspace, path.join(root, "file.txt"))).resolves.toBeTruthy();
  });
});
