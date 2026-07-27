import type { DaemonContext } from "../context.js";
import type { RunService } from "./run-service.js";
import type { ModelRole, SessionId } from "@omniharness/shared-types";
import { RpcError } from "../rpc-server.js";
import { ErrorCodes } from "@omniharness/agent-protocol";

type Register = (name: string, handler: (params: never) => unknown) => void;

/** Agent run commands + model role bindings. */
export function registerRunHandlers(register: Register, ctx: DaemonContext, runs: RunService): void {
  const { db } = ctx;

  const findRun = (runId: string) => {
    for (const session of db.sessions.list({ limit: 1000 }).items) {
      const run = db.agentRuns.listBySession(session.id).find((r) => r.id === runId);
      if (run) return run;
    }
    throw new RpcError(ErrorCodes.NOT_FOUND, `run not found: ${runId}`);
  };

  register("run.start", async (params: { sessionId: SessionId; input: string; modelId?: string }) => {
    return runs.startRun({
      sessionId: params.sessionId,
      input: params.input,
      ...(params.modelId ? { modelId: params.modelId } : {}),
    });
  });

  register("run.steer", (params: { runId: string; input: string }) => {
    runs.steer(params.runId, params.input);
    return { ok: true as const };
  });

  register("run.enqueueFollowUp", (params: { sessionId: SessionId; input: string }) => {
    return { queuePosition: runs.enqueueFollowUp(params.sessionId, params.input) };
  });

  register("run.interrupt", (params: { runId: string }) => {
    runs.interrupt(params.runId);
    return { ok: true as const };
  });

  register("run.resume", async (params: { runId: string }) => {
    // The Pi agent transcript persists per session, so a fresh run continues it.
    const run = findRun(params.runId);
    return runs.startRun({ sessionId: run.sessionId, input: "Continue." });
  });

  register("run.retry", async (params: { runId: string }) => {
    const run = findRun(params.runId);
    const messages = db.messages.listBySession(run.sessionId, { limit: 50 }).items;
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const input = lastUser?.parts.find((p) => p.type === "text")?.text;
    if (!input) throw new RpcError(ErrorCodes.INVALID_PARAMS, "no user message to retry");
    return runs.startRun({ sessionId: run.sessionId, input });
  });

  register("run.list", (params: { sessionId: SessionId }) => ({
    runs: db.agentRuns.listBySession(params.sessionId),
  }));

  register("agent.list", (params: { sessionId?: SessionId }) => ({
    agents: params.sessionId ? db.agents.listBySession(params.sessionId) : [],
  }));

  register("model.setRoleBinding", (params: {
    role: ModelRole;
    modelId: string | null;
    scope?: string;
    sessionId?: string;
  }) => {
    const scope = params.scope ?? "profile";
    const scopeId = scope === "session" ? (params.sessionId ?? "") : "";
    db.settings.set(scope as never, scopeId, `models.bindings.${params.role}`, params.modelId);
    runs.invalidateRouter();
    ctx.bus.emit({
      type: "model.changed",
      sessionId: (params.sessionId ?? "") as SessionId,
      modelId: params.modelId ?? "",
      role: params.role,
    });
    return { ok: true as const };
  });

  register("model.getRoleBindings", (params: { sessionId?: string }) => {
    const entries = db.settings.list("profile" as never, "");
    const bindings: Record<string, string> = {};
    for (const e of entries) {
      if (e.key.startsWith("models.bindings.") && typeof e.value === "string") {
        bindings[e.key.slice("models.bindings.".length)] = e.value;
      }
    }
    if (params.sessionId) {
      for (const e of db.settings.list("session" as never, params.sessionId)) {
        if (e.key.startsWith("models.bindings.") && typeof e.value === "string") {
          bindings[e.key.slice("models.bindings.".length)] = e.value;
        }
      }
    }
    return { bindings };
  });
}
