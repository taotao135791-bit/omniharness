import type { OmniDatabase } from "@omniharness/session-store";
import { importHermesMemories, type HermesMemoriesImportOptions } from "./hermes-memories.js";
import { importHermesSessions, type HermesSessionsImportOptions } from "./hermes-sessions.js";
import { importHermesSkills, type HermesSkillsImportOptions } from "./hermes-skills.js";
import type { ImportReport } from "./report.js";

/**
 * Facade over the three Hermes importers (memories, state.db sessions,
 * skills). Each stage is independent and returns its own ImportReport.
 */
export class HermesImporter {
  constructor(private readonly db: OmniDatabase) {}

  /** Import MEMORY.md / USER.md into the memories table. */
  importMemories(options: Omit<HermesMemoriesImportOptions, "db">): ImportReport {
    return importHermesMemories({ ...options, db: this.db });
  }

  /** Import sessions + messages from a Hermes state.db (read-only). */
  importSessions(options: Omit<HermesSessionsImportOptions, "db">): ImportReport {
    return importHermesSessions({ ...options, db: this.db });
  }

  /** Convert skills/**\/SKILL.md files and pass them to the injected callback. */
  importSkills(options: Omit<HermesSkillsImportOptions, "db">): Promise<ImportReport> {
    return importHermesSkills({ ...options, db: this.db });
  }
}
