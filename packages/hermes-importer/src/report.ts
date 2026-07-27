/**
 * Structured result of every importer in this package.
 *
 * `imported` counts successfully converted top-level source items (messages,
 * settings keys, memories, sessions, skills, MCP servers — the unit is
 * documented per importer). Skipped items always carry a reason; errors are
 * non-fatal (the import continues) unless the importer documents otherwise.
 */
export interface ImportSkip {
  /** Source identifier (file path, entry id, settings key, ...). */
  id: string;
  reason: string;
}

export interface ImportError {
  /** Source identifier when known, else null. */
  id: string | null;
  message: string;
}

export interface ImportReport {
  imported: number;
  skipped: ImportSkip[];
  errors: ImportError[];
  warnings: string[];
}

/** Options shared by all importers. */
export interface ImportOptions {
  /** Analyse sources and produce the report without writing anything. */
  dryRun?: boolean;
}

/** Mutable accumulator; call {@link finish} to freeze into an {@link ImportReport}. */
export class ImportReportBuilder {
  private importedCount = 0;
  readonly skipped: ImportSkip[] = [];
  readonly errors: ImportError[] = [];
  readonly warnings: string[] = [];

  imported(n = 1): void {
    this.importedCount += n;
  }

  skip(id: string, reason: string): void {
    this.skipped.push({ id, reason });
  }

  error(id: string | null, message: string): void {
    this.errors.push({ id, message });
  }

  warn(message: string): void {
    this.warnings.push(message);
  }

  finish(): ImportReport {
    return {
      imported: this.importedCount,
      skipped: this.skipped,
      errors: this.errors,
      warnings: this.warnings,
    };
  }
}

/** Combine several reports into one (counts summed, lists concatenated). */
export function mergeReports(reports: readonly ImportReport[]): ImportReport {
  const out = new ImportReportBuilder();
  for (const report of reports) {
    out.imported(report.imported);
    out.skipped.push(...report.skipped);
    out.errors.push(...report.errors);
    out.warnings.push(...report.warnings);
  }
  return out.finish();
}
