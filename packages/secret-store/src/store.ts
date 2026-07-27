/**
 * Secret storage abstraction. API keys and other credentials are referenced
 * everywhere else in the system by a namespaced ref string (for example
 * `provider:<providerId>:apiKey`) — the secret value itself never appears in
 * plain config JSON.
 */

/** Namespaced secret reference, e.g. `provider:openai:apiKey`. */
export type SecretRef = string;

export interface SecretStore {
  /** Returns the secret, or null when the ref does not exist. */
  get(ref: SecretRef): Promise<string | null>;
  /** Creates or overwrites a secret. */
  set(ref: SecretRef, value: string): Promise<void>;
  /** Removes a secret; deleting a missing ref is a no-op. */
  delete(ref: SecretRef): Promise<void>;
  /** Lists all refs known to this store. */
  list(): Promise<SecretRef[]>;
}

export type SecretStoreBackendKind =
  "macos-keychain" | "windows-credential" | "linux-secret-tool" | "encrypted-file";

export class SecretStoreError extends Error {
  readonly ref?: string;
  constructor(message: string, options?: { ref?: string; cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "SecretStoreError";
    if (options?.ref !== undefined) this.ref = options.ref;
  }
}
