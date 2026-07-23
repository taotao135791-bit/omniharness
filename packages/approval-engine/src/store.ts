import type {
  ApprovalId,
  ApprovalRequest,
  ApprovalStatus,
  Capability,
} from "@omniharness/shared-types";

/** Filter criteria for listing approval requests. */
export interface ApprovalFilter {
  status?: ApprovalStatus;
  capability?: Capability;
  /** Matches against `detail.sessionId` (see engine conventions). */
  sessionId?: string;
}

/**
 * Persistence interface for approval requests. The daemon backs this with
 * SQLite; tests and fallbacks can use {@link InMemoryApprovalStore}.
 */
export interface ApprovalStore {
  insert(req: ApprovalRequest): Promise<void>;
  update(req: ApprovalRequest): Promise<void>;
  get(id: ApprovalId): Promise<ApprovalRequest | null>;
  list(filter?: ApprovalFilter): Promise<ApprovalRequest[]>;
}

function matchesFilter(req: ApprovalRequest, filter: ApprovalFilter): boolean {
  if (filter.status !== undefined && req.status !== filter.status) return false;
  if (filter.capability !== undefined && req.capability !== filter.capability) return false;
  if (filter.sessionId !== undefined && req.detail["sessionId"] !== filter.sessionId) {
    return false;
  }
  return true;
}

/**
 * Reference in-memory implementation of {@link ApprovalStore}. Used by tests
 * and available to the daemon as a non-durable fallback.
 */
export class InMemoryApprovalStore implements ApprovalStore {
  private readonly requests = new Map<ApprovalId, ApprovalRequest>();

  insert(req: ApprovalRequest): Promise<void> {
    this.requests.set(req.id, structuredClone(req));
    return Promise.resolve();
  }

  update(req: ApprovalRequest): Promise<void> {
    this.requests.set(req.id, structuredClone(req));
    return Promise.resolve();
  }

  get(id: ApprovalId): Promise<ApprovalRequest | null> {
    const req = this.requests.get(id);
    return Promise.resolve(req ? structuredClone(req) : null);
  }

  list(filter?: ApprovalFilter): Promise<ApprovalRequest[]> {
    const all = [...this.requests.values()];
    const matched = filter ? all.filter((r) => matchesFilter(r, filter)) : all;
    return Promise.resolve(matched.map((r) => structuredClone(r)));
  }
}
