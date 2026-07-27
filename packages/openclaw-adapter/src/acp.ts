/**
 * AcpRuntime implementation backed by the OmniHarness daemon (ADR-0005).
 *
 * Mirrors the upstream ACP seam (`packages/acp-core/src/runtime/types.ts`):
 * `ensureSession` + streaming `runTurn` emitting text_delta / tool_call /
 * done / error events — but every turn runs in OUR daemon through
 * @omniharness/client-sdk, so tool policy stays in our tool-runtime and
 * approvals in our approval-engine. Remote (channel) approvals are relayed
 * by ChannelApprovalRelay.
 */

import type {
  CommandName,
  CommandParams,
  CommandResult,
  DomainEvent,
} from "@omniharness/agent-protocol";
import type { ApprovalRequest, SessionId, TokenUsage } from "@omniharness/shared-types";
import { noopAudit, stamp } from "./audit.js";
import type { AuditSink } from "./audit.js";
import { formatApprovalPrompt, parseApprovalReply } from "./channels/formatters.js";
import { parseSessionDeliveryRoute, SessionKeyMap } from "./session-keys.js";
import type { SessionDeliveryRoute, SessionKeyMapping } from "./session-keys.js";
import type { ProfileId, WorkspaceId } from "@omniharness/shared-types";

/** Narrow structural view of the daemon connection (satisfied by OmniClient). */
export interface DaemonLike {
  call<N extends CommandName>(name: N, params: CommandParams<N>): Promise<CommandResult<N>>;
  onEvent(handler: (event: DomainEvent) => void): () => void;
}

// ── ACP seam types (upstream packages/acp-core/src/runtime/types.ts) ────────

export type AcpRuntimeEvent =
  | { type: "text_delta"; text: string; stream?: "output" | "thought" }
  | { type: "status"; status: string }
  | { type: "tool_call"; text: string; toolCallId?: string; status?: string; kind?: string }
  | { type: "done"; status?: "ok" | "error" | "cancelled"; stopReason?: string; usage?: TokenUsage }
  | { type: "error"; message: string; code?: string; retryable?: boolean };

export interface AcpRuntimeHandle {
  sessionKey: string;
  sessionId: SessionId;
  profileId: ProfileId;
}

export interface EnsureSessionOptions {
  /** OmniHarness route for new sessions (required when the key is unmapped). */
  route?: { profileId: ProfileId; workspaceId: WorkspaceId };
  title?: string;
  modelId?: string;
  /** Upstream parity: persistent sessions are reused across turns. */
  mode?: "persistent" | "oneshot";
}

export interface RunTurnOptions {
  onEvent?: (event: AcpRuntimeEvent) => void;
  attachments?: Array<{ uri: string; mimeType: string; name: string }>;
  mode?: "prompt" | "steer";
  signal?: AbortSignal;
  /** Abort the daemon run after this many ms. Default 10 minutes. */
  turnTimeoutMs?: number;
}

export class AcpRuntimeError extends Error {
  constructor(
    message: string,
    public readonly code: string = "acp_error",
  ) {
    super(message);
    this.name = "AcpRuntimeError";
  }
}

interface ActiveTurn {
  runId: string;
  sessionKey: string;
  sessionId: SessionId;
  onEvent: ((event: AcpRuntimeEvent) => void) | undefined;
  resolve: (event: AcpRuntimeEvent & { type: "done" }) => void;
  unsubscribe: () => void;
  timeout: ReturnType<typeof setTimeout> | null;
  abortListener: (() => void) | null;
}

export class OmniAcpRuntime {
  private readonly sessionKeys: SessionKeyMap;
  private readonly audit: AuditSink;
  private readonly activeTurns = new Map<SessionId, ActiveTurn>();

  constructor(
    private readonly daemon: DaemonLike,
    deps: { sessionKeys?: SessionKeyMap; audit?: AuditSink } = {},
  ) {
    this.sessionKeys = deps.sessionKeys ?? new SessionKeyMap();
    this.audit = deps.audit ?? noopAudit;
  }

  get mappings(): SessionKeyMap {
    return this.sessionKeys;
  }

  /** Create or find the OmniHarness session backing an OpenClaw session key. */
  async ensureSession(sessionKey: string, opts: EnsureSessionOptions = {}): Promise<AcpRuntimeHandle> {
    const existing = this.sessionKeys.get(sessionKey);
    if (existing) {
      return { sessionKey, sessionId: existing.sessionId, profileId: existing.profileId };
    }
    if (!opts.route) {
      throw new AcpRuntimeError(
        `no OmniHarness session mapped for ${sessionKey} and no route provided`,
        "session_not_mapped",
      );
    }
    const { session } = await this.daemon.call("session.create", {
      workspaceId: opts.route.workspaceId,
      title: opts.title ?? sessionKey,
      profileId: opts.route.profileId,
      ...(opts.modelId ? { modelId: opts.modelId } : {}),
    });
    const mapping: SessionKeyMapping = {
      sessionKey,
      sessionId: session.id,
      profileId: session.profileId,
    };
    const delivery = parseSessionDeliveryRoute(sessionKey);
    if (delivery) mapping.deliveryRoute = delivery;
    this.sessionKeys.register(mapping);
    this.audit(
      stamp({
        kind: "session.mapped",
        sessionKey,
        sessionId: session.id,
        profileId: session.profileId,
      }),
    );
    return { sessionKey, sessionId: session.id, profileId: session.profileId };
  }

  /**
   * Run one turn. Streams daemon message.delta events as ACP text_delta,
   * summarizes tool.call.* as tool_call events, and resolves with `done`
   * (including usage) when the run completes.
   */
  async runTurn(
    sessionKey: string,
    prompt: string,
    opts: RunTurnOptions = {},
  ): Promise<AcpRuntimeEvent & { type: "done" }> {
    const mapping = this.sessionKeys.get(sessionKey);
    if (!mapping) {
      throw new AcpRuntimeError(`ensureSession must be called before runTurn (${sessionKey})`, "session_not_mapped");
    }
    const sessionId = mapping.sessionId;

    if (opts.mode === "steer") {
      const active = this.activeTurns.get(sessionId);
      if (!active) throw new AcpRuntimeError("no active run to steer", "no_active_run");
      await this.daemon.call("run.steer", { runId: active.runId, input: prompt });
      return { type: "done", status: "ok", stopReason: "steered" };
    }

    if (this.activeTurns.has(sessionId)) {
      throw new AcpRuntimeError("a turn is already active for this session", "turn_active");
    }

    const emit = (e: AcpRuntimeEvent): void => opts.onEvent?.(e);

    const done = new Promise<AcpRuntimeEvent & { type: "done" }>((resolve, reject) => {
      const turn: ActiveTurn = {
        runId: "",
        sessionKey,
        sessionId,
        onEvent: opts.onEvent,
        resolve,
        unsubscribe: () => {},
        timeout: null,
        abortListener: null,
      };

      const finish = (event: AcpRuntimeEvent & { type: "done" }): void => {
        if (turn.timeout) clearTimeout(turn.timeout);
        if (turn.abortListener && opts.signal) opts.signal.removeEventListener("abort", turn.abortListener);
        turn.unsubscribe();
        this.activeTurns.delete(sessionId);
        this.audit(
          stamp({
            kind: "turn.finished",
            sessionKey,
            sessionId,
            runId: turn.runId,
            status: event.status ?? "ok",
          }),
        );
        resolve(event);
      };

      turn.unsubscribe = this.daemon.onEvent((event: DomainEvent) => {
        if (!("sessionId" in event) || event.sessionId !== sessionId) return;
        switch (event.type) {
          case "message.delta":
            emit({
              type: "text_delta",
              text: event.delta,
              stream: event.channel === "reasoning" ? "thought" : "output",
            });
            break;
          case "tool.call.started":
            emit({ type: "tool_call", text: event.toolName, toolCallId: event.toolCallId, status: "started" });
            break;
          case "tool.call.completed":
            emit({ type: "tool_call", text: event.toolCallId, toolCallId: event.toolCallId, status: "completed" });
            break;
          case "tool.call.failed":
            emit({ type: "tool_call", text: event.error, toolCallId: event.toolCallId, status: "failed" });
            break;
          case "tool.call.denied":
            emit({ type: "tool_call", text: event.reason, toolCallId: event.toolCallId, status: "denied" });
            break;
          case "run.started":
            if (turn.runId === "") turn.runId = event.runId;
            break;
          case "run.completed":
            if (event.runId !== turn.runId) return;
            finish({ type: "done", status: "ok", usage: event.usage });
            break;
          case "run.failed":
            if (event.runId !== turn.runId) return;
            emit({ type: "error", message: event.error, code: "run_failed" });
            finish({ type: "done", status: "error", stopReason: event.error });
            break;
          default:
            break;
        }
      });

      this.activeTurns.set(sessionId, turn);

      const interrupt = (): void => {
        if (turn.runId) void this.daemon.call("run.interrupt", { runId: turn.runId }).catch(() => {});
        finish({ type: "done", status: "cancelled", stopReason: "interrupted" });
      };
      if (opts.signal) {
        if (opts.signal.aborted) {
          turn.unsubscribe();
          this.activeTurns.delete(sessionId);
          return reject(new AcpRuntimeError("aborted before start", "aborted"));
        }
        turn.abortListener = interrupt;
        opts.signal.addEventListener("abort", turn.abortListener, { once: true });
      }
      const timeoutMs = opts.turnTimeoutMs ?? 10 * 60 * 1000;
      turn.timeout = setTimeout(() => {
        if (turn.runId) void this.daemon.call("run.interrupt", { runId: turn.runId }).catch(() => {});
        emit({ type: "error", message: "turn timed out", code: "turn_timeout", retryable: true });
        finish({ type: "done", status: "cancelled", stopReason: "timeout" });
      }, timeoutMs);

      this.daemon
        .call("run.start", {
          sessionId,
          input: prompt,
          ...(opts.attachments && opts.attachments.length > 0 ? { attachments: opts.attachments } : {}),
        })
        .then(({ runId }) => {
          turn.runId = runId;
          this.audit(stamp({ kind: "turn.started", sessionKey, sessionId, runId }));
        })
        .catch((e: unknown) => {
          const message = e instanceof Error ? e.message : String(e);
          emit({ type: "error", message, code: "run_start_failed" });
          finish({ type: "done", status: "error", stopReason: message });
        });
    });

    return done;
  }

  /** Cancel any active turn for a session key (upstream AcpRuntime.cancel parity). */
  async cancel(sessionKey: string): Promise<void> {
    const mapping = this.sessionKeys.get(sessionKey);
    if (!mapping) return;
    const active = this.activeTurns.get(mapping.sessionId);
    if (active?.runId) await this.daemon.call("run.interrupt", { runId: active.runId });
  }

  async close(): Promise<void> {
    for (const [sessionId] of this.activeTurns) {
      const active = this.activeTurns.get(sessionId);
      if (active?.runId) await this.daemon.call("run.interrupt", { runId: active.runId }).catch(() => {});
    }
  }
}

// ── channel approval relay ──────────────────────────────────────────────────

export interface ChannelTarget {
  route: SessionDeliveryRoute;
  channel: string;
  accountId: string;
}

export interface ApprovalRelayDeps {
  daemon: DaemonLike;
  sessionKeys: SessionKeyMap;
  /** Deliver a text message to a channel target. */
  send: (target: ChannelTarget, text: string) => Promise<void>;
  timeoutMs?: number;
  audit?: AuditSink;
}

interface PendingApproval {
  approval: ApprovalRequest;
  sessionKey: string;
  target: ChannelTarget;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Relays daemon approval requests to the channel that owns the session, and
 * maps the channel user's yes/no reply back to approval.resolve.
 */
export class ChannelApprovalRelay {
  private readonly audit: AuditSink;
  private readonly timeoutMs: number;
  private unsubscribe: (() => void) | null = null;
  /** toolCallId → sessionId, learned from tool.call.started events. */
  private readonly toolCallSessions = new Map<string, SessionId>();
  /** sessionKey → pending approval (one at a time per session). */
  private readonly pending = new Map<string, PendingApproval>();

  constructor(private readonly deps: ApprovalRelayDeps) {
    this.audit = deps.audit ?? noopAudit;
    this.timeoutMs = deps.timeoutMs ?? 120_000;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.deps.daemon.onEvent((event: DomainEvent) => {
      if (event.type === "tool.call.started") {
        this.toolCallSessions.set(event.toolCallId, event.sessionId);
        return;
      }
      if (event.type === "approval.requested") {
        void this.onApprovalRequested(event.approval);
        return;
      }
      if (event.type === "approval.resolved") {
        this.clearResolved(event.approvalId);
      }
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const [, p] of this.pending) clearTimeout(p.timer);
    this.pending.clear();
  }

  private async onApprovalRequested(approval: ApprovalRequest): Promise<void> {
    const sessionId = this.toolCallSessions.get(approval.toolCallId);
    if (!sessionId) return; // not a session we have seen tool calls for
    const mapping = this.deps.sessionKeys.getBySessionId(sessionId);
    if (!mapping?.deliveryRoute) return; // not channel-owned

    const target: ChannelTarget = {
      route: mapping.deliveryRoute,
      channel: mapping.deliveryRoute.channel,
      accountId: mapping.deliveryRoute.accountId ?? "default",
    };
    this.audit(
      stamp({
        kind: "approval.requested",
        approvalId: approval.id,
        sessionId,
        capability: approval.capability,
        channel: target.channel,
      }),
    );
    const expiresInSeconds = Math.max(1, (Date.parse(approval.expiresAt) - Date.now()) / 1000);
    const text = formatApprovalPrompt({
      approvalId: approval.id,
      capability: approval.capability,
      risk: approval.risk,
      summary: approval.summary,
      expiresInSeconds: Math.min(expiresInSeconds, this.timeoutMs / 1000),
    });
    try {
      await this.deps.send(target, text);
    } catch {
      return; // delivery failed; leave resolution to other surfaces
    }
    const timer = setTimeout(() => {
      const p = this.pending.get(mapping.sessionKey);
      if (!p || p.approval.id !== approval.id) return;
      this.pending.delete(mapping.sessionKey);
      this.audit(
        stamp({
          kind: "approval.relayed",
          approvalId: approval.id,
          decision: "timeout",
          channel: target.channel,
        }),
      );
      void this.deps
        .send(target, `Approval ${approval.id} timed out; no action was taken.`)
        .catch(() => {});
    }, this.timeoutMs);
    // replace any previous pending entry for this session
    const prev = this.pending.get(mapping.sessionKey);
    if (prev) clearTimeout(prev.timer);
    this.pending.set(mapping.sessionKey, { approval, sessionKey: mapping.sessionKey, target, timer });
  }

  private clearResolved(approvalId: string): void {
    for (const [key, p] of this.pending) {
      if (p.approval.id === approvalId) {
        clearTimeout(p.timer);
        this.pending.delete(key);
      }
    }
  }

  /**
   * Try to interpret an inbound channel message as an approval reply.
   * Returns true when the message was consumed as a reply.
   */
  handleChannelReply(message: { sessionKey: string; senderId: string; body: string }): boolean {
    const p = this.pending.get(message.sessionKey);
    if (!p) return false;
    const decision = parseApprovalReply(message.body);
    if (!decision) return false;
    clearTimeout(p.timer);
    this.pending.delete(message.sessionKey);
    this.audit(
      stamp({
        kind: "approval.relayed",
        approvalId: p.approval.id,
        decision,
        senderId: message.senderId,
        channel: p.target.channel,
      }),
    );
    void this.deps.daemon
      .call("approval.resolve", { approvalId: p.approval.id, decision })
      .then(() =>
        this.deps.send(p.target, `Approval ${decision === "approve" ? "granted ✅" : "denied ❌"}.`),
      )
      .catch(() => {});
    return true;
  }
}
