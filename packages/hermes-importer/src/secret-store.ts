/**
 * Secret storage abstraction used by the importers. Structurally identical to
 * the `SecretStore` interface of `@omniharness/secret-store`, so any instance
 * of that package satisfies this interface without a dependency edge.
 *
 * Secrets from imported config (Pi `auth.json`, MCP env values, ...) are
 * written here; only the `SecretRef` strings ever land in plain JSON records.
 */

/** Namespaced secret reference, e.g. `provider:prov_pi_acme:apiKey`. */
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

/** Deterministic in-memory SecretStore, handy for tests and dry tooling. */
export class InMemorySecretStore implements SecretStore {
  private readonly values = new Map<string, string>();

  get(ref: SecretRef): Promise<string | null> {
    return Promise.resolve(this.values.get(ref) ?? null);
  }

  set(ref: SecretRef, value: string): Promise<void> {
    this.values.set(ref, value);
    return Promise.resolve();
  }

  delete(ref: SecretRef): Promise<void> {
    this.values.delete(ref);
    return Promise.resolve();
  }

  list(): Promise<SecretRef[]> {
    return Promise.resolve([...this.values.keys()].sort());
  }
}
