import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { OmniDatabase } from "@omniharness/session-store";
import { ImportStateTracker } from "./import-state.js";
import { errMessage } from "./json-utils.js";
import { type ImportOptions, type ImportReport, ImportReportBuilder } from "./report.js";

/**
 * Importer for agent instruction files found in a workspace. Files are merged
 * into ONE project-instruction document with per-file provenance markers.
 *
 * Merge order (documented, deterministic):
 *   1. CLAUDE.md      — Claude-Code conventions, widely used
 *   2. AGENTS.md      — the cross-harness standard
 *   3. .pi/AGENTS.md  — Pi project-local overlay of the standard
 *   4. SYSTEM.md      — generic system instructions, lowest precedence
 *
 * Earlier files win conceptually (callers should treat the document as
 * ordered); every section carries BEGIN/END markers naming its source file.
 */
export const INSTRUCTION_FILE_ORDER = [
  "CLAUDE.md",
  "AGENTS.md",
  ".pi/AGENTS.md",
  "SYSTEM.md",
] as const;

export interface InstructionImportReport extends ImportReport {
  /** Files found, in merge order (workspace-relative). */
  files: string[];
  /** The merged document (also written to outputPath when given). */
  merged: string;
}

export interface InstructionFileImportOptions extends ImportOptions {
  workspaceRoot: string;
  db: OmniDatabase;
  /** When set, the merged document is written here (unless dry-run). */
  outputPath?: string;
}

/** Merge already-loaded instruction files, in the given order. */
export function mergeInstructionFiles(
  files: ReadonlyArray<{ path: string; content: string }>,
): string {
  const sections: string[] = [
    "# Project Instructions (imported)",
    "",
    `Merge order: ${INSTRUCTION_FILE_ORDER.join(" → ")}. Earlier files take precedence.`,
  ];
  for (const file of files) {
    sections.push(
      "",
      `<!-- BEGIN omni:instructions source="${file.path}" -->`,
      "",
      file.content.trim(),
      "",
      `<!-- END omni:instructions source="${file.path}" -->`,
    );
  }
  return sections.join("\n") + "\n";
}

/** Find + merge instruction files in a workspace root. */
export function importInstructionFiles(
  options: InstructionFileImportOptions,
): InstructionImportReport {
  const report = new ImportReportBuilder();
  const dryRun = options.dryRun ?? false;
  const tracker = new ImportStateTracker(options.db, "instructions", dryRun);

  const found: Array<{ path: string; content: string }> = [];
  for (const relative of INSTRUCTION_FILE_ORDER) {
    const full = join(options.workspaceRoot, relative);
    if (!existsSync(full)) continue;
    try {
      found.push({ path: relative, content: readFileSync(full, "utf8") });
    } catch (err) {
      report.error(relative, `cannot read instruction file: ${errMessage(err)}`);
    }
  }
  if (found.length === 0) {
    report.warn(`no instruction files found in ${options.workspaceRoot}`);
  }

  const merged = mergeInstructionFiles(found);
  const sourceKey = options.workspaceRoot;
  if (tracker.has(sourceKey)) {
    report.skip(sourceKey, "already imported");
  } else if (found.length > 0) {
    if (!dryRun) {
      if (options.outputPath !== undefined) {
        mkdirSync(dirname(options.outputPath), { recursive: true });
        writeFileSync(options.outputPath, merged);
      }
      tracker.mark(sourceKey, options.outputPath ?? "(in-memory)");
    }
    report.imported(found.length);
  }
  return { ...report.finish(), files: found.map((f) => f.path), merged };
}

/** Stateful facade around {@link importInstructionFiles}. */
export class InstructionFileImporter {
  constructor(private readonly db: OmniDatabase) {}

  import(options: Omit<InstructionFileImportOptions, "db">): InstructionImportReport {
    return importInstructionFiles({ ...options, db: this.db });
  }
}
