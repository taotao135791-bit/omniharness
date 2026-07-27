import fs from "node:fs";
import path from "node:path";
import type { DaemonContext } from "../context.js";
import { RpcError } from "../rpc-server.js";
import { ErrorCodes } from "@omniharness/agent-protocol";
import { nowIso } from "@omniharness/shared-types";

type Register = (name: string, handler: (params: never) => unknown) => void;

/** Full data export (open formats) and full data deletion (GDPR-style). */
export function registerDataHandlers(register: Register, ctx: DaemonContext): void {
  const { db, paths } = ctx;

  register("data.exportAll", (params: { targetDir: string }) => {
    const target = path.resolve(params.targetDir);
    fs.mkdirSync(target, { recursive: true });
    db.exportAll(target);
    const artifact = {
      id: `export_${Date.now().toString(36)}`,
      kind: "export" as const,
      name: `omniharness-export-${nowIso().slice(0, 10)}`,
      mimeType: "application/x-directory",
      sizeBytes: 0,
      uri: `file://${target}`,
      createdAt: nowIso(),
    };
    return { artifact };
  });

  register("data.deleteAll", (params: { confirm: boolean }) => {
    if (params.confirm !== true) {
      throw new RpcError(ErrorCodes.INVALID_PARAMS, "data.deleteAll requires confirm: true");
    }
    // Close the DB before wiping; the daemon must be restarted after this.
    ctx.log.warn("FULL DATA DELETE requested — wiping data dir", { dataDir: paths.dataDir });
    db.close();
    fs.rmSync(paths.dataDir, { recursive: true, force: true });
    // Schedule shutdown so no further writes hit the deleted dir.
    setTimeout(() => process.exit(0), 100);
    return { ok: true as const };
  });
}
