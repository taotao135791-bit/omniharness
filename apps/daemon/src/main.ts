#!/usr/bin/env node
import { loadBrand } from "@omniharness/config-schema";
import { createDaemonContext, type DaemonContext } from "./context.js";
import { loadOrCreateAuthToken, removeRuntimeInfo, resolvePaths, writeRuntimeInfo } from "./paths.js";
import { registerSessionHandlers } from "./services/session-handlers.js";
import { registerSystemHandlers } from "./services/system-handlers.js";
import { registerMemoryHandlers } from "./services/memory-handlers.js";
import { registerSkillHandlers } from "./services/skill-handlers.js";
import { registerAutomationHandlers } from "./services/automation-handlers.js";
import { registerWorkspaceHandlers } from "./services/workspace-handlers.js";
import { registerPluginHandlers } from "./services/plugin-handlers.js";
import { registerToolHandlers } from "./services/tool-handlers.js";
import { registerDataHandlers } from "./services/data-handlers.js";
import { registerRunHandlers } from "./services/run-handlers.js";
import { RunService } from "./services/run-service.js";
import { registerImportHandlers } from "./services/import-handlers.js";
import { registerChannelHandlers } from "./services/channel-handlers.js";
import { Scheduler, type AutomationRunner } from "@omniharness/automation-engine";
import type { Session, SessionId } from "@omniharness/shared-types";
import { nowIso } from "@omniharness/shared-types";

export async function startDaemon(opts?: {
  dataDir?: string;
  host?: string;
  port?: number;
  /** Test-only: scripts for fixture-kind providers, keyed by provider id. */
  fixtureScripts?: ReadonlyMap<string, import("@omniharness/model-gateway").FixtureResponse[]>;
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
  registerWorkspaceHandlers(register, ctx);
  registerPluginHandlers(register, ctx);
  registerToolHandlers(register, ctx);
  registerDataHandlers(register, ctx);
  registerImportHandlers(register, ctx);
  registerChannelHandlers(register, ctx);

  // ── agent runs ──
  const runService = new RunService(ctx, opts?.fixtureScripts);
  registerRunHandlers(register, ctx, runService);
  runService.recoverOnBoot();

  // ── automation scheduler: runs prompts in isolated, tool-restricted sessions ──
  const automationRunner: AutomationRunner = {
    run: async (automation, runCtx) => {
      void runCtx;
      const profile = ctx.db.profiles.get(automation.profileId) ?? ctx.db.profiles.getDefault();
      if (!profile) return { error: "profile not found" };
      const workspace = ctx.db.workspaces.get(automation.workspaceId);
      if (!workspace) return { error: "workspace not found" };
      const session: Session = {
        id: `sess_auto_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}` as Session["id"],
        profileId: profile.id as Session["profileId"],
        projectId: workspace.projectId,
        workspaceId: workspace.id,
        title: `automation: ${automation.name}`,
        tags: ["automation"],
        status: "active",
        headMessageId: null,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        totalUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
      ctx.db.sessions.create(session);
      runService.setToolRestriction(session.id, automation.allowedTools);
      try {
        const { runId } = await runService.startRun({
          sessionId: session.id as SessionId,
          input: automation.prompt,
        });
        return await new Promise((resolve) => {
          const off = ctx.bus.subscribe((event) => {
            if (event.type === "run.completed" && "runId" in event && event.runId === runId) {
              off();
              const lastMsg = ctx.db.messages
                .listBySession(session.id as SessionId, { limit: 1 })
                .items.at(-1);
              const summary =
                lastMsg?.parts.find((p) => p.type === "text")?.text?.slice(0, 500) ?? "completed";
              resolve({ sessionId: session.id, resultSummary: summary });
            }
            if (event.type === "run.failed" && "runId" in event && event.runId === runId) {
              off();
              resolve({ error: event.error });
            }
          });
        });
      } finally {
        runService.setToolRestriction(session.id as SessionId, null);
      }
    },
  };
  const scheduler = new Scheduler({ engine: ctx.automations.engine, runner: automationRunner });
  ctx.automations.setScheduler(scheduler);
  if (process.env.OMNIHARNESS_AUTOMATIONS !== "off") scheduler.start();

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
