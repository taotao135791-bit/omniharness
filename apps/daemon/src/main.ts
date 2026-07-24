#!/usr/bin/env node
import { loadBrand } from "@omniharness/config-schema";
import { createDaemonContext, type DaemonContext } from "./context.js";
import { loadOrCreateAuthToken, removeRuntimeInfo, resolvePaths, writeRuntimeInfo } from "./paths.js";
import { registerSessionHandlers } from "./services/session-handlers.js";
import { registerSystemHandlers } from "./services/system-handlers.js";
import { registerMemoryHandlers } from "./services/memory-handlers.js";
import { registerSkillHandlers } from "./services/skill-handlers.js";
import { registerAutomationHandlers } from "./services/automation-handlers.js";

export async function startDaemon(opts?: {
  dataDir?: string;
  host?: string;
  port?: number;
}): Promise<DaemonContext> {
  const brand = loadBrand();
  const paths = resolvePaths(opts?.dataDir);
  const authToken = loadOrCreateAuthToken(paths.dataDir);
  const ctx = await createDaemonContext({
    paths,
    authToken,
    host: opts?.host ?? "127.0.0.1",
    port: opts?.port ?? 0,
    version: "0.1.0",
  });

  const register = (name: string, handler: (params: never) => unknown): void =>
    ctx.rpc.register(name as never, handler as never);

  registerSystemHandlers(register, {
    db: ctx.db,
    bus: ctx.bus,
    tracer: ctx.tracer,
    secrets: ctx.secrets,
    dataDir: paths.dataDir,
    version: ctx.version,
    startedAt: ctx.startedAt,
  });
  registerSessionHandlers(register, ctx.db, ctx.bus);
  registerMemoryHandlers(register, ctx);
  registerSkillHandlers(register, ctx);
  registerAutomationHandlers(register, ctx);

  // system.shutdown is registered here because it needs the stop hook.
  register("system.shutdown", () => {
    setTimeout(() => void stopDaemon(ctx), 50);
    return { ok: true as const };
  });

  await ctx.rpc.start();
  writeRuntimeInfo(paths.runtimeFile, {
    port: ctx.rpc.port,
    host: opts?.host ?? "127.0.0.1",
    authToken,
    pid: process.pid,
    version: ctx.version,
    startedAt: new Date().toISOString(),
  });
  ctx.log.info(`${brand.product.displayName} daemon started`, { port: ctx.rpc.port });
  return ctx;
}

export async function stopDaemon(ctx: DaemonContext): Promise<void> {
  ctx.rpc.broadcastShutdown("shutdown requested");
  await ctx.rpc.stop();
  removeRuntimeInfo(ctx.paths.runtimeFile);
  ctx.db.close();
  ctx.log.info("daemon stopped");
}

// Direct execution entry.
if (import.meta.url === `file://${process.argv[1]}`) {
  startDaemon().catch((err) => {
    console.error("daemon failed to start:", err);
    process.exit(1);
  });
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => process.exit(0));
  }
}
