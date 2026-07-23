import { randomUUID } from "node:crypto";
import type {
  ApprovalId,
  ApprovalRequest,
  Capability,
  PolicyDecisionKind,
  RiskLevel,
  ToolCallId,
} from "@omniharness/shared-types";
import type { ApprovalFilter, ApprovalStore } from "./store.js";

/**
 * Detail-key convention: {@link ApprovalRequest} has no dedicated fields for
 * the owning session or the concrete action target, so the engine stores them
 * inside `detail` under the reserved keys `"sessionId"` and `"target"`.
 * Callers pass the target via `CreateApprovalInput.detail.target`.
 */
export const DETAIL_SESSION_ID_KEY = "sessionId";
export const DETAIL_TARGET_KEY = "target";

export interface CreateApprovalInput {
  toolCallId: ToolCallId;
  capability: Capability;
  risk: RiskLevel;
  summary: string;
  /** Machine-readable detail; include `target` for dedupe/grant keying. */
  detail: Record<string, string>;
  /** Stored into `detail.sessionId`. */
  sessionId?: string;
  /** Per-request timeout; defaults to the engine's `defaultTimeoutMs`. */
  timeoutMs?: number;
}

export type ApprovalEvent =
  | { type: "approval.requested"; request: ApprovalRequest }
  | { type: "approval.resolved"; request: ApprovalRequest };

export interface ApprovalEngineOptions {
  store: ApprovalStore;
  /** Injectable clock for testability. Defaults to wall-clock time. */
  clock?: () => Date;
  /** Default request lifetime. Defaults to 5 minutes. */
  defaultTimeoutMs?: number;
  onEvent?: (event: ApprovalEvent) => void;
  /** Defaults to a random `appr_<uuid>` id via node:crypto. */
  idGenerator?: () => ApprovalId;
}

export type ResolveDecision = "approve" | "deny";

/** Error thrown when an approval id does not exist. */
export class ApprovalNotFoundError extends Error {
  constructor(id: ApprovalId) {
    super(`Approval request not found: ${id}`);
    this.name = "ApprovalNotFoundError";
  }
}

/** Error thrown when resolving/cancelling an already-resolved request. */
export class ApprovalAlreadyResolvedError extends Error {
  constructor(id: ApprovalId, status: string) {
    super(`Approval request ${id} is already resolved (status: ${status})`);
    this.name = "ApprovalAlreadyResolvedError";
  }
}

type GrantKind = "once" | "session" | "workspace";

const WORKSPACE_TARGET_WILDCARD = "*";

function grantKey(sessionId: string, capability: Capability, target: string): string {
  return `${sessionId}${capability}${target}`;
}

function defaultIdGenerator(): ApprovalId {
  return `appr_${randomUUID()}` as ApprovalId;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Approval request lifecycle engine.
 *
 * - Requests are persisted through an injected {@link ApprovalStore}.
 * - Time comes from an injected clock; expiry is enforced lazily: any read or
 *   mutation that touches an overdue pending request transitions it to
 *   `expired` (resolvedBy `"timeout"`, resolvedAt = expiresAt), persists it,
 *   and emits `approval.resolved`.
 * - Session/workspace/one-time grants (for `ask_once_per_session`,
 *   `allow_for_workspace`, and default one-shot approvals) are kept IN MEMORY
 *   only. They do not survive a process restart; a daemon that needs durable
 *   grants must re-derive them from persisted approvals.
 */
export class ApprovalEngine {
  private readonly store: ApprovalStore;
  private readonly clock: () => Date;
  private readonly defaultTimeoutMs: number;
  private readonly onEvent: ((event: ApprovalEvent) => void) | undefined;
  private readonly idGenerator: () => ApprovalId;
  private readonly grants = new Map<string, GrantKind>();

  constructor(options: ApprovalEngineOptions) {
    this.store = options.store;
    this.clock = options.clock ?? (() => new Date());
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.onEvent = options.onEvent;
    this.idGenerator = options.idGenerator ?? defaultIdGenerator;
  }

  /**
   * Create a pending approval request, or return the existing pending request
   * when one with the same capability + target + sessionId already exists
   * (dedupe — no second insert, no second `approval.requested` event).
   */
  async create(input: CreateApprovalInput): Promise<ApprovalRequest> {
    const detail: Record<string, string> = { ...input.detail };
    if (input.sessionId !== undefined) {
      detail[DETAIL_SESSION_ID_KEY] = input.sessionId;
    }
    const sessionId = detail[DETAIL_SESSION_ID_KEY];
    const target = detail[DETAIL_TARGET_KEY];

    const pending = await this.list({ status: "pending", capability: input.capability });
    const existing = pending.find(
      (r) =>
        r.detail[DETAIL_TARGET_KEY] === target && r.detail[DETAIL_SESSION_ID_KEY] === sessionId,
    );
    if (existing) {
      return existing;
    }

    const now = this.clock();
    const timeoutMs = input.timeoutMs ?? this.defaultTimeoutMs;
    const request: ApprovalRequest = {
      id: this.idGenerator(),
      toolCallId: input.toolCallId,
      capability: input.capability,
      risk: input.risk,
      summary: input.summary,
      detail,
      status: "pending",
      createdAt: now.toISOString(),
      resolvedAt: null,
      resolvedBy: null,
      expiresAt: new Date(now.getTime() + timeoutMs).toISOString(),
    };
    await this.store.insert(request);
    this.emit({ type: "approval.requested", request });
    return request;
  }

  /**
   * Resolve a pending request. Approve records a grant according to
   * `grantedScope`:
   * - `"ask_once_per_session"` → session grant keyed (sessionId, capability, target)
   * - `"allow_for_workspace"` → workspace grant keyed (sessionId, capability), any target
   * - absent, `"ask_every_time"`, or any other scope → one-time grant keyed
   *   (sessionId, capability, target)
   *
   * Throws {@link ApprovalNotFoundError} on unknown id and
   * {@link ApprovalAlreadyResolvedError} on already-resolved requests
   * (including lazily-expired ones).
   */
  async resolve(
    id: ApprovalId,
    decision: ResolveDecision,
    grantedScope?: PolicyDecisionKind,
  ): Promise<ApprovalRequest> {
    const request = await this.requirePending(id);
    const now = this.clock().toISOString();

    if (decision === "approve") {
      request.status = "approved";
      request.resolvedBy = "user";
      request.resolvedAt = now;
      if (grantedScope !== undefined) {
        request.grantedScope = grantedScope;
      }
      this.recordGrant(request, grantedScope);
    } else {
      request.status = "denied";
      request.resolvedBy = "user";
      request.resolvedAt = now;
    }

    await this.store.update(request);
    this.emit({ type: "approval.resolved", request });
    return request;
  }

  /** Cancel a pending request. `resolvedBy` stays null. */
  async cancel(id: ApprovalId): Promise<ApprovalRequest> {
    const request = await this.requirePending(id);
    request.status = "cancelled";
    request.resolvedAt = this.clock().toISOString();
    await this.store.update(request);
    this.emit({ type: "approval.resolved", request });
    return request;
  }

  /** Fetch a request by id, applying lazy expiry. */
  async get(id: ApprovalId): Promise<ApprovalRequest | null> {
    const request = await this.store.get(id);
    if (!request) return null;
    return this.applyLazyExpiry(request);
  }

  /** List requests, applying lazy expiry before filtering. */
  async list(filter?: ApprovalFilter): Promise<ApprovalRequest[]> {
    const all = await this.store.list();
    const current = await Promise.all(all.map((r) => this.applyLazyExpiry(r)));
    if (!filter) return current;
    return current.filter((r) => {
      if (filter.status !== undefined && r.status !== filter.status) return false;
      if (filter.capability !== undefined && r.capability !== filter.capability) return false;
      if (
        filter.sessionId !== undefined &&
        r.detail[DETAIL_SESSION_ID_KEY] !== filter.sessionId
      ) {
        return false;
      }
      return true;
    });
  }

  /**
   * Consume a grant for (sessionId, capability, target). One-time grants are
   * removed on consume; session and workspace grants persist. Workspace
   * grants match any target within their session.
   */
  consumeSessionGrant(capability: Capability, target: string, sessionId: string): boolean {
    const exactKey = grantKey(sessionId, capability, target);
    const exact = this.grants.get(exactKey);
    if (exact !== undefined) {
      if (exact === "once") {
        this.grants.delete(exactKey);
      }
      return true;
    }
    return this.grants.has(grantKey(sessionId, capability, WORKSPACE_TARGET_WILDCARD));
  }

  /** Expire every overdue pending request. Returns how many were expired. */
  async sweepExpired(): Promise<number> {
    const pending = await this.store.list({ status: "pending" });
    let count = 0;
    for (const request of pending) {
      const wasPending = request.status === "pending";
      await this.applyLazyExpiry(request);
      if (wasPending && request.status === "expired") {
        count += 1;
      }
    }
    return count;
  }

  private emit(event: ApprovalEvent): void {
    this.onEvent?.(event);
  }

  private isOverdue(request: ApprovalRequest): boolean {
    return request.status === "pending" && this.clock().getTime() >= Date.parse(request.expiresAt);
  }

  /**
   * If the request is an overdue pending request, transition it to expired,
   * persist, and emit `approval.resolved`. Returns the (possibly mutated)
   * request.
   */
  private async applyLazyExpiry(request: ApprovalRequest): Promise<ApprovalRequest> {
    if (!this.isOverdue(request)) return request;
    request.status = "expired";
    request.resolvedBy = "timeout";
    request.resolvedAt = request.expiresAt;
    await this.store.update(request);
    this.emit({ type: "approval.resolved", request });
    return request;
  }

  /** Fetch + lazy-expire + assert the request is still pending. */
  private async requirePending(id: ApprovalId): Promise<ApprovalRequest> {
    const request = await this.store.get(id);
    if (!request) {
      throw new ApprovalNotFoundError(id);
    }
    const current = await this.applyLazyExpiry(request);
    if (current.status !== "pending") {
      throw new ApprovalAlreadyResolvedError(id, current.status);
    }
    return current;
  }

  private recordGrant(request: ApprovalRequest, grantedScope: PolicyDecisionKind | undefined): void {
    const sessionId = request.detail[DETAIL_SESSION_ID_KEY];
    const target = request.detail[DETAIL_TARGET_KEY];
    if (sessionId === undefined) return; // Grants are session-scoped; nothing to key on.

    if (grantedScope === "ask_once_per_session") {
      if (target === undefined) return;
      this.grants.set(grantKey(sessionId, request.capability, target), "session");
    } else if (grantedScope === "allow_for_workspace") {
      this.grants.set(
        grantKey(sessionId, request.capability, WORKSPACE_TARGET_WILDCARD),
        "workspace",
      );
    } else {
      // Absent, "ask_every_time", or any other scope: one-time grant.
      if (target === undefined) return;
      this.grants.set(grantKey(sessionId, request.capability, target), "once");
    }
  }
}
