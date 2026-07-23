/** HTTP-level failure from a provider (non-2xx response). */
export class ProviderHttpError extends Error {
  readonly status: number;
  readonly retryAfterMs?: number;
  readonly body?: string;

  constructor(status: number, message: string, options?: { retryAfterMs?: number; body?: string }) {
    super(message);
    this.name = "ProviderHttpError";
    this.status = status;
    if (options?.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
    if (options?.body !== undefined) this.body = options.body;
  }
}

export function isRateLimitError(err: unknown): err is ProviderHttpError {
  return err instanceof ProviderHttpError && err.status === 429;
}

export function isTransientServerError(err: unknown): err is ProviderHttpError {
  return err instanceof ProviderHttpError && err.status >= 500 && err.status < 600;
}

/** True for errors worth retrying with backoff (429 and transient 5xx). */
export function isRetryableProviderError(err: unknown): boolean {
  return isRateLimitError(err) || isTransientServerError(err);
}

/** Thrown for configured providers whose transport is not implemented (e.g. AWS Bedrock SigV4). */
export class NotImplementedProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotImplementedProviderError";
  }
}

export class BudgetExceededError extends Error {
  readonly spent: number;
  readonly limit: number;
  readonly kind: "cost" | "tokens";

  constructor(kind: "cost" | "tokens", spent: number, limit: number) {
    super(
      kind === "cost"
        ? `Model cost budget exceeded: $${spent.toFixed(4)} spent of $${limit.toFixed(4)} allowed`
        : `Model token budget exceeded: ${spent} tokens used of ${limit} allowed`,
    );
    this.name = "BudgetExceededError";
    this.kind = kind;
    this.spent = spent;
    this.limit = limit;
  }
}

export class NoModelForRoleError extends Error {
  readonly role: string;
  constructor(role: string, detail?: string) {
    super(`No model available for role "${role}"${detail !== undefined ? `: ${detail}` : ""}`);
    this.name = "NoModelForRoleError";
    this.role = role;
  }
}
