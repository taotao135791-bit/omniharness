import {
  createProviderFromConfig,
  FixtureProvider,
  ModelCapabilityRegistry,
  ModelRouter,
  type FixtureResponse,
  type ModelProvider,
} from "@omniharness/model-gateway";
import type {
  Agent,
  AgentRun,
  Capability,
  ModelDefinition,
  ModelId,
  RiskLevel,
  SessionId,
  Workspace,
  WorkspaceId,
} from "@omniharness/shared-types";
import { nowIso } from "@omniharness/shared-types";
import type { DaemonContext } from "../context.js";
import { PiAgentRuntime, type RuntimeEvent } from "@omniharness/runtime-pi";
import { createCoreTools, ToolRegistry, type ApprovalGateResult } from "@omniharness/tool-runtime";
import * as policyEngineModule from "@omniharness/policy-engine";
import { nanoid } from "./id.js";
import { RpcError } from "../rpc-server.js";
import { ErrorCodes } from "@omniharness/agent-protocol";
import fs from "node:fs";
import path from "node:path";

/**
 * The daemon's agent-run service: owns the ModelRouter and one PiAgentRuntime
 * per workspace, pumps runtime events into the durable event bus, and persists
 * messages/tool calls/usage as runs proceed.
 */
export class RunService {
  private router: ModelRouter | null = null;
  private readonly runtimes = new Map<WorkspaceId, PiAgentRuntime>();
  /** Fixture providers persist across router rebuilds so scripts are consumed once. */
  private readonly fixtureProviders = new Map<string, FixtureProvider>();
  private readonly activeRuns = new Map<
    string,
    { sessionId: SessionId; runtime: PiAgentRuntime }
  >();
  private readonly approvalWaiters = new Map<string, (result: ApprovalGateResult) => void>();
  /** Per-session tool allowlists (automations run restricted). */
  private readonly toolRestrictions = new Map<string, ReadonlySet<string>>();

  /** Restrict which tools a session may call (null clears the restriction). */
  setToolRestriction(sessionId: SessionId, tools: readonly string[] | null): void {
    if (tools === null) this.toolRestrictions.delete(sessionId);
    else this.toolRestrictions.set(sessionId, new Set(tools));
  }

  constructor(
    private readonly ctx: DaemonContext,
    private readonly fixtureScripts?: ReadonlyMap<string, FixtureResponse[]>,
  ) {
    // Approval resolutions unblock waiting tool calls.
    ctx.bus.subscribe((event) => {
      if (event.type !== "approval.resolved") return;
      const waiter = this.approvalWaiters.get(event.approvalId);
      if (!waiter) return;
      this.approvalWaiters.delete(event.approvalId);
      waiter(
        event.status === "approved"
          ? { approved: true }
          : { approved: false, reason: `approval ${event.status}` },
      );
    });
  }

  /**
   * Policy evaluation needs the workspace root to apply product defaults
   * (fs.write/fs.read inside the workspace auto-allow). Rules come from the
   * shared engine; per-workspace engines are built fresh (rules are few).
   */
  private policyFor(
    workspaceId: string | undefined,
  ): import("@omniharness/policy-engine").PolicyEngine {
    const { PolicyEngine } = policyEngineModule;
    const root = workspaceId
      ? this.ctx.db.workspaces.get(workspaceId as never)?.roots[0]
      : undefined;
    const engine = new PolicyEngine(root !== undefined ? { workspaceRoot: root } : {});
    // Mirror the shared engine's rules into the scoped one is unnecessary for
    // product defaults; user rules are read from the DB-backed shared engine.
    void this.ctx.policy;
    return engine;
  }

  /** Build the model router from persisted providers/models. */
  private async ensureRouter(): Promise<ModelRouter> {
    if (this.router) return this.router;
    const { db, secrets } = this.ctx;
    const registry = new ModelCapabilityRegistry();
    const providers = new Map<string, ModelProvider>();
    for (const config of db.providers.list(true)) {
      try {
        if (config.kind === "fixture") {
          let fp = this.fixtureProviders.get(config.id);
          if (!fp) {
            const script = this.fixtureScripts?.get(config.id);
            if (!script)
              throw new Error(`fixture provider ${config.id} has no script (test-only kind)`);
            fp = new FixtureProvider(script);
            this.fixtureProviders.set(config.id, fp);
          }
          providers.set(config.id, fp);
          continue;
        }
        providers.set(config.id, await createProviderFromConfig(config, secrets));
      } catch (err) {
        this.ctx.log.warn("provider init failed", {
          provider: config.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    for (const provider of db.providers.list(true)) {
      for (const model of db.models.listByProvider(provider.id, true)) {
        registry.register(model);
      }
    }
    const bindings: Record<string, string> = {};
    const fallbacks: Record<string, string[]> = {};
    for (const entry of db.settings.list("profile" as never, "")) {
      if (
        entry.key.startsWith("models.bindings.") &&
        typeof entry.value === "string" &&
        entry.value
      ) {
        bindings[entry.key.slice("models.bindings.".length)] = entry.value;
      }
      if (entry.key.startsWith("models.fallbacks.") && Array.isArray(entry.value)) {
        fallbacks[entry.key.slice("models.fallbacks.".length)] = entry.value as string[];
      }
    }
    this.router = new ModelRouter({
      registry,
      providers,
      bindings: bindings as never,
      fallbacks: fallbacks as never,
      onModelFallback: (role, fromModelId, toModelId, reason) => {
        this.ctx.bus.emit({
          type: "model.fallback",
          sessionId: "" as never,
          fromModelId,
          toModelId,
          reason: `[${role}] ${reason}`,
        });
      },
      recordUsage: (rec) => {
        db.modelUsage.record({
          at: rec.at,
          modelId: rec.modelId,
          profileId: null,
          projectId: null,
          sessionId: null,
          agentId: null,
          automationId: null,
          usage: rec.usage,
        });
      },
    });
    return this.router;
  }

  /** Register/update a model definition (provider refresh + tests). */
  registerModel(model: ModelDefinition): void {
    this.ctx.db.models.put(model);
    this.router = null;
  }

  /** Invalidate the cached router (after provider add/remove). */
  invalidateRouter(): void {
    this.router = null;
    // Runtimes capture the router at construction — they must be rebuilt too
    // (drops in-flight Pi agent state for this workspace; acceptable on
    // provider/model changes).
    this.runtimes.clear();
  }

  private async getRuntime(workspace: Workspace): Promise<PiAgentRuntime> {
    const existing = this.runtimes.get(workspace.id);
    if (existing) return existing;
    const router = await this.ensureRouter();
    const registry = new ToolRegistry();
    for (const tool of createCoreTools()) registry.register(tool);
    const { ctx } = this;
    const runtime = new PiAgentRuntime({
      router,
      registry,
      policy: {
        evaluate: (policyCtx) => {
          const restriction = policyCtx.sessionId
            ? this.toolRestrictions.get(policyCtx.sessionId)
            : undefined;
          if (restriction && !restriction.has(policyCtx.toolName)) {
            return {
              decision: "deny",
              risk: "high",
              matchedScope: "automation",
              reason: `tool ${policyCtx.toolName} not in automation allowlist`,
            } as const;
          }
          return this.policyFor(policyCtx.workspaceId).evaluate(policyCtx);
        },
      },
      approvalGate: {
        request: (info) => this.requestApproval(info),
      },
      workspace,
      buildContext: async (sessionId) => {
        const sections: string[] = [];
        const session = ctx.db.sessions.get(sessionId);
        if (session) {
          const block = ctx.memory.buildContextBlock(
            session.profileId,
            session.projectId,
            undefined,
            8,
          );
          if (block) sections.push(block);
        }
        const skills = await ctx.skills.listEffective();
        const enabled = skills.filter((s) => s.enabled);
        if (enabled.length > 0) {
          sections.push(
            "## Available skills\n" +
              enabled.map((s) => `- **${s.name}**: ${s.description}`).join("\n"),
          );
        }
        const agentsMd = workspace.roots
          .map((r) => path.join(r, "AGENTS.md"))
          .find((p) => fs.existsSync(p));
        if (agentsMd)
          sections.push(
            `## Project instructions (AGENTS.md)\n${fs.readFileSync(agentsMd, "utf8")}`,
          );
        return sections;
      },
      recorder: {
        recordMessage: (_runId, message) => {
          const sessionId = message.sessionId as SessionId;
          try {
            ctx.db.messages.add({
              id: message.messageId as never,
              sessionId,
              parentId: null,
              role: message.role,
              parts: [{ type: "text", text: message.text }],
              createdAt: nowIso(),
            });
          } catch (err) {
            ctx.log.warn("message recording failed", {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        },
        recordToolCall: (_runId, call) => {
          const sessionId = call.sessionId as SessionId;
          try {
            // NOTE: the runtime's run id is not the daemon's agentRun id —
            // agentRunId stays null to respect the FK.
            ctx.db.toolCalls.put({
              id: call.toolCallId as never,
              sessionId,
              agentRunId: null,
              messageId: null,
              name: call.toolName,
              argumentsJson: call.argumentsJson,
              status: call.status,
              resultJson: call.status === "completed" ? call.output : null,
              error: call.status === "failed" || call.status === "denied" ? call.output : null,
              capability: null,
              startedAt: nowIso(),
              endedAt: nowIso(),
            });
          } catch (err) {
            ctx.log.warn("tool call recording failed", {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        },
      },
    });
    this.runtimes.set(workspace.id, runtime);
    return runtime;
  }

  /** Bridge a tool-approval request into the approval engine and wait. */
  private async requestApproval(info: {
    toolName: string;
    capability: Capability;
    risk: RiskLevel;
    summary: string;
    detail: Record<string, string>;
    sessionId?: string;
    workspaceId?: string;
  }): Promise<ApprovalGateResult> {
    const toolCallId = nanoid("tc");
    // approvals.tool_call_id has a FK to tool_calls — register the call first.
    const sessionId = info.sessionId ?? [...this.activeRuns.values()][0]?.sessionId;
    if (sessionId) {
      this.ctx.db.toolCalls.put({
        id: toolCallId as never,
        sessionId: sessionId as never,
        agentRunId: null,
        messageId: null,
        name: info.toolName,
        argumentsJson: "{}",
        status: "running" as never,
        resultJson: null,
        error: null,
        capability: info.capability,
        startedAt: nowIso(),
        endedAt: null,
      });
    }
    const approval = await this.ctx.approvals.create({
      toolCallId: toolCallId as never,
      capability: info.capability,
      risk: info.risk,
      summary: info.summary,
      detail: { ...info.detail, toolName: info.toolName },
    });
    this.ctx.bus.emit({ type: "approval.requested", approval });
    return new Promise<ApprovalGateResult>((resolve) => {
      this.approvalWaiters.set(approval.id, resolve);
      // Expiry: resolve as denied when the request lapses.
      const expiresAt = Date.parse(approval.expiresAt);
      const delay = Math.max(1000, expiresAt - Date.now() + 500);
      setTimeout(() => {
        const waiter = this.approvalWaiters.get(approval.id);
        if (waiter) {
          this.approvalWaiters.delete(approval.id);
          waiter({ approved: false, reason: "approval expired" });
        }
      }, delay).unref();
    });
  }

  /** Start a run and pump its events into the bus + database. */
  async startRun(params: {
    sessionId: SessionId;
    input: string;
    modelId?: string;
  }): Promise<{ runId: string }> {
    const { db, bus } = this.ctx;
    const session = db.sessions.get(params.sessionId);
    if (!session) throw new RpcError(ErrorCodes.NOT_FOUND, "session not found");
    const workspace = db.workspaces.get(session.workspaceId);
    if (!workspace) throw new RpcError(ErrorCodes.NOT_FOUND, "workspace not found");
    const runtime = await this.getRuntime(workspace);

    const agentId = nanoid("agent") as Agent["id"];
    const runId = nanoid("run");
    db.agents.put({
      id: agentId,
      sessionId: session.id,
      kind: "primary",
      parentAgentId: null,
      displayName: "primary",
      status: "running",
      allowedTools: null,
      createdAt: nowIso(),
    });
    const run: AgentRun = {
      id: runId as AgentRun["id"],
      agentId,
      sessionId: session.id,
      status: "running",
      startedAt: nowIso(),
      endedAt: null,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      lastEventSeq: 0,
    };
    db.agentRuns.put(run);
    bus.emit({
      type: "run.started",
      sessionId: session.id,
      runId,
      agentId,
      modelId: params.modelId ?? "",
    });

    void (async () => {
      try {
        for await (const event of runtime.startRun({
          sessionId: session.id,
          input: params.input,
          ...(params.modelId ? { modelId: params.modelId as ModelId } : {}),
        })) {
          this.forwardEvent(session.id, runId, event);
        }
        db.agentRuns.finish(run.id, "completed", nowIso());
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        bus.emit({ type: "run.failed", sessionId: session.id, runId, error: message });
        db.agentRuns.finish(run.id, "failed", nowIso());
      }
    })();

    this.activeRuns.set(runId, { sessionId: session.id, runtime });
    return { runId };
  }

  private forwardEvent(sessionId: SessionId, runId: string, event: RuntimeEvent): void {
    const { bus } = this.ctx;
    switch (event.type) {
      case "message.started":
        bus.emit({
          type: "message.started",
          sessionId,
          messageId: event.messageId,
          role: event.role,
        });
        break;
      case "message.delta":
        bus.emit({
          type: "message.delta",
          sessionId,
          messageId: event.messageId,
          delta: event.delta,
          channel: event.channel,
        });
        break;
      case "message.completed":
        bus.emit({ type: "message.completed", sessionId, messageId: event.messageId });
        break;
      case "tool.call.started":
        bus.emit({
          type: "tool.call.started",
          sessionId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          argumentsJson: event.argumentsJson,
        });
        break;
      case "tool.call.output":
        bus.emit({
          type: "tool.call.output",
          sessionId,
          toolCallId: event.toolCallId,
          chunk: event.chunk,
          stream: event.stream,
        });
        break;
      case "tool.call.completed":
        bus.emit({
          type: "tool.call.completed",
          sessionId,
          toolCallId: event.toolCallId,
          resultJson: event.resultJson,
          durationMs: event.durationMs,
        });
        break;
      case "tool.call.failed":
        bus.emit({
          type: "tool.call.failed",
          sessionId,
          toolCallId: event.toolCallId,
          error: event.error,
        });
        break;
      case "tool.call.denied":
        bus.emit({
          type: "tool.call.denied",
          sessionId,
          toolCallId: event.toolCallId,
          reason: event.reason,
        });
        break;
      case "run.compacting":
        bus.emit({ type: "run.compacting", sessionId, runId, beforeTokens: event.beforeTokens });
        break;
      case "run.compacted":
        bus.emit({ type: "run.compacted", sessionId, runId, afterTokens: event.afterTokens });
        break;
      case "run.completed":
        this.activeRuns.delete(runId);
        bus.emit({ type: "run.completed", sessionId, runId, usage: event.usage });
        break;
      case "run.failed":
        this.activeRuns.delete(runId);
        bus.emit({ type: "run.failed", sessionId, runId, error: event.error });
        break;
      default:
        break;
    }
  }

  steer(runId: string, input: string): void {
    const active = this.activeRuns.get(runId);
    if (!active) throw new RpcError(ErrorCodes.NOT_FOUND, "run not active");
    active.runtime.steer(runId, input);
    this.ctx.bus.emit({ type: "run.steered", sessionId: active.sessionId, runId });
  }

  enqueueFollowUp(sessionId: SessionId, input: string): number {
    const active = [...this.activeRuns.entries()].find(([, v]) => v.sessionId === sessionId);
    if (!active) throw new RpcError(ErrorCodes.NOT_FOUND, "no active run for session");
    active[1].runtime.enqueueFollowUp(active[0], input);
    return 1;
  }

  interrupt(runId: string): void {
    const active = this.activeRuns.get(runId);
    if (!active) throw new RpcError(ErrorCodes.NOT_FOUND, "run not active");
    active.runtime.interrupt(runId);
    this.activeRuns.delete(runId);
    this.ctx.db.agentRuns.finish(runId as AgentRun["id"], "interrupted", nowIso());
  }

  /** Crash recovery: mark orphaned runs interrupted. */
  recoverOnBoot(): void {
    for (const run of this.ctx.db.agentRuns.listByStatus("running")) {
      this.ctx.db.agentRuns.finish(run.id, "interrupted", nowIso());
      this.ctx.log.warn("recovered orphaned run", { runId: run.id });
    }
  }
}
