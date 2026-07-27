import type { DaemonContext } from "../context.js";
import { createCoreTools, ToolRegistry } from "@omniharness/tool-runtime";
import { RpcError } from "../rpc-server.js";
import { ErrorCodes } from "@omniharness/agent-protocol";
import type { ApprovalDecision } from "@omniharness/agent-protocol";

type Register = (name: string, handler: (params: never) => unknown) => void;

/** Tool listing, approvals, and policy introspection. */
export function registerToolHandlers(register: Register, ctx: DaemonContext): void {
  const { db, approvals, bus } = ctx;

  const registry = new ToolRegistry();
  for (const tool of createCoreTools()) {
    registry.register(tool);
  }

  register("tool.list", () => ({
    tools: registry.list().map((summary) => {
      const full = registry.get(summary.name);
      return {
        name: summary.name,
        description: summary.description,
        parametersSchema: full?.parametersSchema ?? {},
        capabilities: summary.requiredCapabilities,
        source: "core" as const,
      };
    }),
  }));

  register("approval.list", (params: { status?: string; limit?: number }) => {
    const status = params.status ?? "pending";
    const all = db.approvals.listByStatus(status as never);
    return { approvals: all.slice(0, params.limit ?? 50) };
  });

  register(
    "approval.resolve",
    async (params: { approvalId: string; decision: ApprovalDecision; rememberScope?: string }) => {
      const record = db.approvals.get(params.approvalId as never);
      if (!record) throw new RpcError(ErrorCodes.NOT_FOUND, "approval not found");
      const approval = await approvals.resolve(
        params.approvalId as never,
        params.decision,
        params.rememberScope as never,
      );
      bus.emit({
        type: "approval.resolved",
        approvalId: params.approvalId as never,
        status: params.decision === "approve" ? "approved" : "denied",
      });
      return { approval };
    },
  );

  register("policy.get", () => ({ rules: db.permissionRules.list() }));

  register("policy.set", (params: { rules: unknown[] }) => {
    // Full replace of profile-scope ruleset is a later UI concern; for now append.
    for (const rule of params.rules) {
      db.permissionRules.add({ kind: "profile", profileId: "default" }, rule as never);
    }
    return { ok: true as const };
  });
}
