/**
 * Secure fill: credentials never enter the model's context. The model emits a
 * `secure_fill` action carrying only an opaque `secretRef`; the session
 * resolves the reference through an injected SecretResolver at execution time
 * and types the value straight into the input driver. The value is never
 * written to the trace, the context, or any proposer-visible structure.
 */
export interface SecretResolver {
  /** Names of available references, safe to show to the proposer. */
  listRefs(): string[];
  /** Resolves a reference to its value. Must reject unknown references. */
  resolve(ref: string): Promise<string>;
}

/** Simple in-memory resolver, mostly for tests and embedding. */
export class MapSecretResolver implements SecretResolver {
  private readonly secrets: ReadonlyMap<string, string>;

  constructor(secrets: Record<string, string>) {
    this.secrets = new Map(Object.entries(secrets));
  }

  listRefs(): string[] {
    return [...this.secrets.keys()];
  }

  resolve(ref: string): Promise<string> {
    const value = this.secrets.get(ref);
    if (value === undefined) {
      return Promise.reject(new Error(`unknown secret reference: ${ref}`));
    }
    return Promise.resolve(value);
  }
}

/**
 * Throws if `secretValue` appears anywhere in `payload`. Used as a defense
 * in-depth assertion before a context object is handed to a proposer.
 */
export function assertNoSecretLeak(payload: unknown, secretValue: string): void {
  if (secretValue.length === 0) {
    return;
  }
  if (JSON.stringify(payload).includes(secretValue)) {
    throw new Error("secret value would be exposed in proposer-visible context");
  }
}
