import type {
  PolicyDecisionKind,
  PolicyEvaluation,
  PolicyEvaluationContext,
  RiskLevel,
} from "@omniharness/shared-types";
import type { Workspace } from "@omniharness/shared-types";
import { LocalArtifactStore } from "./artifacts.js";
import type { ArtifactStore } from "./artifacts.js";
import type { ToolRegistry } from "./registry.js";
import { validateArgs } from "./schema.js";
import { err } from "./types.js";
import type { Tool, ToolContext, ToolOutputChunk, ToolResult } from "./types.js";

/** Matches policy-engine's evaluate(ctx: PolicyEvaluationContext): PolicyEvaluation. */
export interface PolicyEvaluator {
  evaluate(ctx: PolicyEvaluationContext): PolicyEvaluation | Promise<PolicyEvaluation>;
}

export interface ApprovalRequestInfo {
  toolName: string;
  capability: PolicyEvaluationContext["capability"];
  risk: RiskLevel;
  summary: string;
  detail: Record<string, string>;
  /** Session the call belongs to (for approval persistence/attribution). */
  sessionId?: string;
  workspaceId?: string;
}

export interface ApprovalGateResult {
  approved: boolean;
  reason?: string;
}

export interface ApprovalGate {
  request(info: ApprovalRequestInfo): Promise<ApprovalGateResult>;
}

export interface AuditEntry {
  toolName: string;
  sessionId: string;
  agentId: string;
  /** Pipeline stage that produced the outcome. */
  outcome:
    | "executed"
    | "validation_failed"
    | "policy_denied"
    | "approval_denied"
    | "timed_out"
    | "tool_not_found";
  decision?: PolicyDecisionKind;
  ok: boolean;
  durationMs: number;
  timestamp: string;
  error?: string;
}

export type AuditSink = (entry: AuditEntry) => void | Promise<void>;

export interface ToolRuntimeOptions {
  policy: PolicyEvaluator;
  /** Required to satisfy ask_* decisions; without it they are denied. */
  approval?: ApprovalGate;
  onAudit?: AuditSink;
  /** Output longer than this is truncated; the remainder becomes an artifact. */
  maxOutputChars?: number;
  artifactStore?: ArtifactStore;
  /** Default per-run timeout in ms (overridable per run). */
  defaultTimeoutMs?: number;
}

export interface ToolRunContext {
  workspace: Workspace;
  sessionId: string;
  agentId: string;
  signal?: AbortSignal;
  emit?: (chunk: ToolOutputChunk) => void;
}

export interface ToolRunOptions {
  timeoutMs?: number;
}

const DEFAULT_MAX_OUTPUT_CHARS = 50_000;
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Best-effort extraction of the concrete target (path / command line) for
 * policy evaluation, based on common argument names.
 */
function deriveTarget(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const obj = args as Record<string, unknown>;
  if (typeof obj["path"] === "string") return obj["path"];
  if (typeof obj["command"] === "string") {
    const rest = Array.isArray(obj["args"]) ? obj["args"].map(String).join(" ") : "";
    return rest === "" ? obj["command"] : `${obj["command"]} ${rest}`;
  }
  return undefined;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<ToolOutputChunk> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in (value as Record<PropertyKey, unknown>)
  );
}

/**
 * Executes tools through the fixed pipeline:
 * schema validation → policy evaluation → approval → execute → sanitize → audit.
 */
export class ToolRuntime {
  private readonly registry: ToolRegistry;
  private readonly policy: PolicyEvaluator;
  private readonly approval: ApprovalGate | undefined;
  private readonly onAudit: AuditSink | undefined;
  private readonly maxOutputChars: number;
  private readonly artifactStore: ArtifactStore;
  private readonly defaultTimeoutMs: number;
  /** sessionId → granted "ask_once_per_session" capability keys. */
  private readonly sessionGrants = new Map<string, Set<string>>();

  constructor(registry: ToolRegistry, opts: ToolRuntimeOptions) {
    this.registry = registry;
    this.policy = opts.policy;
    this.approval = opts.approval;
    this.onAudit = opts.onAudit;
    this.maxOutputChars = opts.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
    this.artifactStore = opts.artifactStore ?? new LocalArtifactStore();
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private async audit(entry: AuditEntry): Promise<void> {
    try {
      await this.onAudit?.(entry);
    } catch {
      // Auditing must never break tool execution.
    }
  }

  async run(
    toolName: string,
    args: unknown,
    runCtx: ToolRunContext,
    runOpts?: ToolRunOptions,
  ): Promise<ToolResult> {
    const started = Date.now();
    const base = {
      toolName,
      sessionId: runCtx.sessionId,
      agentId: runCtx.agentId,
      timestamp: new Date().toISOString(),
    };

    const tool = this.registry.get(toolName);
    if (!tool) {
      const result = err(`Unknown tool: ${toolName}`);
      await this.audit({
        ...base,
        outcome: "tool_not_found",
        ok: false,
        durationMs: Date.now() - started,
        error: result.output,
      });
      return result;
    }

    // 1. Schema validation.
    const validation = validateArgs(tool.parametersSchema, args);
    if (!validation.ok) {
      const result = err(`Invalid arguments for ${toolName}:\n${validation.errors.join("\n")}`);
      await this.audit({
        ...base,
        outcome: "validation_failed",
        ok: false,
        durationMs: Date.now() - started,
        error: validation.errors.join("; "),
      });
      return result;
    }

    // 2. Policy evaluation (+ 3. approval for ask_* decisions).
    const target = deriveTarget(args);
    for (const capability of tool.requiredCapabilities) {
      const evalCtx: PolicyEvaluationContext = {
        capability,
        toolName,
        agentId: runCtx.agentId,
        sessionId: runCtx.sessionId,
        workspaceId: runCtx.workspace.id,
        projectId: runCtx.workspace.projectId,
      };
      if (target !== undefined) evalCtx.target = target;
      const evaluation = await this.policy.evaluate(evalCtx);

      if (evaluation.decision === "deny") {
        const result = err(
          `Policy denied ${toolName}: ${evaluation.reason} (capability ${capability})`,
        );
        await this.audit({
          ...base,
          outcome: "policy_denied",
          decision: evaluation.decision,
          ok: false,
          durationMs: Date.now() - started,
          error: evaluation.reason,
        });
        return result;
      }

      if (evaluation.decision === "ask_every_time" || evaluation.decision === "ask_once_per_session") {
        const grantKey = `${capability}`;
        const grants = this.sessionGrants.get(runCtx.sessionId);
        const alreadyGranted =
          evaluation.decision === "ask_once_per_session" && (grants?.has(grantKey) ?? false);

        if (!alreadyGranted) {
          const approved = await this.requestApproval(tool, capability, evaluation, target, runCtx);
          if (!approved.ok) {
            const result = err(
              `Approval denied for ${toolName}: ${approved.reason ?? "denied by user"}`,
            );
            await this.audit({
              ...base,
              outcome: "approval_denied",
              decision: evaluation.decision,
              ok: false,
              durationMs: Date.now() - started,
              error: approved.reason ?? "denied by user",
            });
            return result;
          }
          if (evaluation.decision === "ask_once_per_session") {
            let set = this.sessionGrants.get(runCtx.sessionId);
            if (!set) {
              set = new Set();
              this.sessionGrants.set(runCtx.sessionId, set);
            }
            set.add(grantKey);
          }
        }
      }
      // allow_for_workspace / allow_with_constraints / always_allow: proceed.
    }

    // 4. Execute (with combined abort + timeout).
    const timeoutMs = runOpts?.timeoutMs ?? this.defaultTimeoutMs;
    const controller = new AbortController();
    const onExternalAbort = (): void => controller.abort(runCtx.signal?.reason);
    if (runCtx.signal) {
      if (runCtx.signal.aborted) controller.abort(runCtx.signal.reason);
      else runCtx.signal.addEventListener("abort", onExternalAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);

    const ctx: ToolContext = {
      workspace: runCtx.workspace,
      sessionId: runCtx.sessionId,
      agentId: runCtx.agentId,
      signal: controller.signal,
      emit: (chunk) => runCtx.emit?.(chunk),
    };

    let result: ToolResult;
    let timedOut = false;
    try {
      result = await this.executeWithTimeout(tool, args, ctx, controller, timeoutMs);
    } catch (error) {
      if (error instanceof TimeoutError) {
        timedOut = true;
        result = err(`Tool ${toolName} timed out after ${timeoutMs} ms`);
      } else {
        result = err(
          `Tool ${toolName} threw: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } finally {
      clearTimeout(timer);
      runCtx.signal?.removeEventListener("abort", onExternalAbort);
    }

    // 5. Result sanitization (truncate + artifact spill).
    result = await this.sanitize(toolName, result);

    // 6. Audit.
    await this.audit({
      ...base,
      outcome: timedOut ? "timed_out" : "executed",
      ok: result.ok,
      durationMs: Date.now() - started,
      ...(result.isError ? { error: result.output.slice(0, 500) } : {}),
    });
    return result;
  }

  private async requestApproval(
    tool: Tool,
    capability: PolicyEvaluationContext["capability"],
    evaluation: PolicyEvaluation,
    target: string | undefined,
    runCtx: ToolRunContext,
  ): Promise<{ ok: boolean; reason?: string }> {
    if (!this.approval) {
      return { ok: false, reason: "no approval gate configured" };
    }
    const detail: Record<string, string> = { tool: tool.name, capability };
    if (target !== undefined) detail["target"] = target;
    const answer = await this.approval.request({
      toolName: tool.name,
      capability,
      risk: evaluation.risk,
      summary: `${tool.name} requests ${capability}${target ? ` on ${target}` : ""} (${evaluation.reason})`,
      detail,
      sessionId: runCtx.sessionId,
      workspaceId: runCtx.workspace.id,
    });
    return answer.approved ? { ok: true } : { ok: false, ...(answer.reason !== undefined ? { reason: answer.reason } : {}) };
  }

  private executeWithTimeout(
    tool: Tool,
    args: unknown,
    ctx: ToolContext,
    controller: AbortController,
    timeoutMs: number,
  ): Promise<ToolResult> {
    const execution = (async (): Promise<ToolResult> => {
      const produced = tool.execute(args as Record<string, unknown>, ctx);
      if (isAsyncIterable(produced)) {
        let output = "";
        for await (const chunk of produced) {
          ctx.emit(chunk);
          output += chunk.text;
        }
        return { ok: true, output };
      }
      return produced;
    })();

    return new Promise<ToolResult>((resolvePromise, rejectPromise) => {
      const onAbort = (): void => {
        if (controller.signal.reason instanceof Error && controller.signal.reason.message === "timeout") {
          rejectPromise(new TimeoutError(`timed out after ${timeoutMs} ms`));
        } else {
          rejectPromise(controller.signal.reason instanceof Error
            ? controller.signal.reason
            : new Error("aborted"));
        }
      };
      controller.signal.addEventListener("abort", onAbort, { once: true });
      execution.then(
        (result) => {
          controller.signal.removeEventListener("abort", onAbort);
          resolvePromise(result);
        },
        (error: unknown) => {
          controller.signal.removeEventListener("abort", onAbort);
          rejectPromise(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  private async sanitize(toolName: string, result: ToolResult): Promise<ToolResult> {
    if (result.output.length <= this.maxOutputChars) return result;
    const remainder = result.output.slice(this.maxOutputChars);
    const artifact = await this.artifactStore.put({
      name: `${toolName}-output.txt`,
      content: remainder,
      mimeType: "text/plain",
    });
    return {
      ...result,
      output:
        result.output.slice(0, this.maxOutputChars) +
        `\n[output truncated: ${remainder.length} more chars in artifact ${artifact.id}]`,
      artifact,
    };
  }
}

class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}
