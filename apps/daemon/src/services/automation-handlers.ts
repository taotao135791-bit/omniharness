import type { DaemonContext } from "../context.js";
import type { Automation } from "@omniharness/shared-types";
import { RpcError } from "../rpc-server.js";
import { ErrorCodes } from "@omniharness/agent-protocol";

type Register = (name: string, handler: (params: never) => unknown) => void;

/** Automation CRUD + run history. Scheduling itself lives in the daemon's scheduler. */
export function registerAutomationHandlers(register: Register, ctx: DaemonContext): void {
  const { automations, bus } = ctx;

  register(
    "automation.create",
    (params: {
      automation: Omit<Automation, "id" | "createdAt" | "updatedAt" | "lastRunAt" | "nextRunAt">;
    }) => {
      const automation = automations.engine.create(params.automation);
      bus.emit({ type: "automation.updated", automation });
      return { automation };
    },
  );

  register("automation.list", (params: { enabledOnly?: boolean }) => {
    return { automations: automations.engine.list(params.enabledOnly ?? false) };
  });

  register("automation.setEnabled", (params: { automationId: string; enabled: boolean }) => {
    automations.engine.setEnabled(params.automationId as Automation["id"], params.enabled);
    return { ok: true as const };
  });

  register("automation.runNow", async (params: { automationId: string }) => {
    if (!automations.scheduler) {
      throw new RpcError(ErrorCodes.INTERNAL, "scheduler not running (automation.enabled off?)");
    }
    const run = await automations.scheduler.runNow(params.automationId as Automation["id"]);
    return { runId: run.id };
  });

  register(
    "automation.runs",
    (params: { automationId?: string; limit?: number; offset?: number }) => {
      const all = params.automationId
        ? automations.engine.listRuns(params.automationId as Automation["id"])
        : automations.engine.list().flatMap((a) => automations.engine.listRuns(a.id));
      const offset = params.offset ?? 0;
      return { runs: all.slice(offset, offset + (params.limit ?? 50)), total: all.length };
    },
  );

  register("automation.delete", (params: { automationId: string }) => {
    automations.engine.delete(params.automationId as Automation["id"]);
    return { ok: true as const };
  });
}
