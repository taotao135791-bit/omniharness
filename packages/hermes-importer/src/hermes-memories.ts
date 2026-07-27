import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type {
  MemoryEntry,
  MemoryId,
  MemoryKind,
  ProfileId,
  ProjectId,
} from "@omniharness/shared-types";
import { nowIso } from "@omniharness/shared-types";
import type { OmniDatabase } from "@omniharness/session-store";
import { ImportStateTracker } from "./import-state.js";
import { errMessage } from "./json-utils.js";
import { type ImportOptions, type ImportReport, ImportReportBuilder } from "./report.js";

/**
 * Importer for Hermes curated-memory files (see docs/research/HERMES_AUDIT.md §3.2):
 *
 * - `MEMORY.md` → kind "semantic", `USER.md` → kind "userPreference";
 * - entries are joined by the literal delimiter `\n§\n` — there is NO escaping
 *   and NO per-entry metadata (no ids, no timestamps) in the source format;
 * - entries are sanitized (control characters stripped) and deduplicated
 *   (order-preserving, like Hermes itself does on load);
 * - imported entries get createdBy "import", confidence 1, approvedByUser
 *   true (they are the user's own curated data) and the source file path as
 *   their evidence ref.
 */

/** Entry delimiter used by Hermes memory files (no escaping exists). */
export const HERMES_ENTRY_DELIMITER = "\n§\n";

/** Strip C0/C1 control chars except \n and \t (memory text stays multiline). */
export function sanitizeMemoryText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

/** Split a Hermes memory file into entries: split, strip, drop empties, dedupe. */
export function parseHermesMemoryFile(raw: string): string[] {
  const entries = raw
    .split(HERMES_ENTRY_DELIMITER)
    .map((entry) => sanitizeMemoryText(entry).trim())
    .filter((entry) => entry.length > 0);
  return [...new Set(entries)];
}

export interface HermesMemoriesImportOptions extends ImportOptions {
  /** Path to MEMORY.md (semantic memories). At least one file is required. */
  memoryMdPath?: string;
  /** Path to USER.md (user-preference memories). */
  userMdPath?: string;
  db: OmniDatabase;
  profileId: ProfileId;
  /** Defaults to null (memory applies to all projects of the profile). */
  projectId?: ProjectId | null;
}

function importOneFile(
  path: string,
  kind: MemoryKind,
  options: HermesMemoriesImportOptions,
  report: ImportReportBuilder,
  tracker: ImportStateTracker,
): void {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    report.error(path, `cannot read memory file: ${errMessage(err)}`);
    return;
  }
  const entries = parseHermesMemoryFile(raw);
  const timestamp = nowIso();
  for (const [index, content] of entries.entries()) {
    const hash = createHash("sha256").update(`${kind}:${content}`).digest("hex").slice(0, 16);
    const sourceKey = `${kind}:${hash}`;
    if (tracker.has(sourceKey)) {
      report.skip(sourceKey, "already imported");
      continue;
    }
    const memoryId = `mem_hermes_${hash}` as MemoryId;
    const entry: MemoryEntry = {
      id: memoryId,
      kind,
      profileId: options.profileId,
      projectId: options.projectId ?? null,
      content,
      summary: content.length > 120 ? `${content.slice(0, 117)}...` : content,
      sourceSessionId: null,
      createdBy: "import",
      createdAt: timestamp,
      lastVerifiedAt: timestamp,
      confidence: 1,
      scope: { profileId: options.profileId, projectId: options.projectId ?? null },
      // The source format carries no approval metadata; these are the user's
      // own curated memories, so they import as approved.
      approvedByUser: true,
      evidenceRefs: [`file:${path}#entry-${index}`],
      sensitivity: "normal",
      expiresAt: null,
      archived: false,
    };
    if (options.dryRun !== true) {
      options.db.memories.put(entry);
      tracker.mark(sourceKey, memoryId);
    }
    report.imported();
  }
}

/** Import Hermes MEMORY.md / USER.md into the memories table. */
export function importHermesMemories(options: HermesMemoriesImportOptions): ImportReport {
  const report = new ImportReportBuilder();
  const tracker = new ImportStateTracker(options.db, "hermes.memories", options.dryRun ?? false);
  if (options.memoryMdPath === undefined && options.userMdPath === undefined) {
    report.error(null, "at least one of memoryMdPath / userMdPath is required");
    return report.finish();
  }
  if (options.memoryMdPath !== undefined) {
    importOneFile(options.memoryMdPath, "semantic", options, report, tracker);
  }
  if (options.userMdPath !== undefined) {
    importOneFile(options.userMdPath, "userPreference", options, report, tracker);
  }
  return report.finish();
}
