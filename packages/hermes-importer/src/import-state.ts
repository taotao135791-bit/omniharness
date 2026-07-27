import type { OmniDatabase } from "@omniharness/session-store";

const SCOPE = "global";
const SCOPE_ID = "hermes-importer";

/**
 * Idempotency ledger: remembers which source ids were already imported,
 * persisted inside the OmniDatabase settings table so re-imports survive
 * restarts. Each importer (or importer section) uses its own namespace.
 *
 * In dry-run mode the ledger is read (so reports reflect what a real run
 * would skip) but never written.
 */
export class ImportStateTracker {
  private readonly seen: Map<string, string>;
  private readonly key: string;

  constructor(
    private readonly db: OmniDatabase,
    namespace: string,
    private readonly dryRun: boolean,
  ) {
    this.key = `import.sources.${namespace}`;
    const raw = db.settings.get(SCOPE, SCOPE_ID, this.key);
    this.seen = new Map<string, string>();
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
      for (const [sourceId, targetId] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof targetId === "string") this.seen.set(sourceId, targetId);
      }
    }
  }

  /** True when this source id was imported by a previous run. */
  has(sourceId: string): boolean {
    return this.seen.has(sourceId);
  }

  /** The internal id a previous run assigned to this source id, if any. */
  targetOf(sourceId: string): string | undefined {
    return this.seen.get(sourceId);
  }

  /** Record a successful import (no-op in dry-run mode). */
  mark(sourceId: string, targetId: string): void {
    if (this.dryRun) return;
    this.seen.set(sourceId, targetId);
    this.db.settings.set(SCOPE, SCOPE_ID, this.key, Object.fromEntries(this.seen));
  }
}
