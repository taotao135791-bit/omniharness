import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { SkillDefinition, SkillId } from "@omniharness/shared-types";
import { nowIso } from "@omniharness/shared-types";
import type { OmniDatabase } from "@omniharness/session-store";
import { ImportStateTracker } from "./import-state.js";
import { asRecord, asString, errMessage } from "./json-utils.js";
import { type ImportOptions, type ImportReport, ImportReportBuilder } from "./report.js";

/**
 * Importer for Hermes skills (`~/.hermes/skills/<name>/SKILL.md`,
 * docs/research/HERMES_AUDIT.md §4.1).
 *
 * The SKILL.md structure is the same agentskills.io-style frontmatter+body
 * format `@omniharness/skill-engine` parses — but Hermes frontmatter carries
 * extra (possibly nested) fields, so this parser is deliberately tolerant:
 * it extracts name/description/version and ignores the rest. Skill identity
 * is the frontmatter `name`, not the directory name (upstream rule).
 *
 * Converted skills are SkillDefinition objects with source "imported" and are
 * handed to the injected `onSkill` callback so the daemon can route them
 * through the skill-engine (validation, storage, versioning). The sidecar
 * `.usage.json` is honored: skills in state "archived" import disabled.
 */

export interface HermesSkillFrontmatter {
  name: string;
  description: string;
  version: string;
}

export interface ParsedHermesSkill {
  frontmatter: HermesSkillFrontmatter;
  body: string;
}

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

/** Directories bundled next to a SKILL.md that count as skill resources. */
export const SKILL_SUPPORT_DIRS = ["references", "templates", "scripts", "assets"] as const;

class SkillParseError extends Error {}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

/**
 * Tolerant SKILL.md split: frontmatter scalar extraction (unknown and nested
 * keys ignored) + markdown body. Throws SkillParseError when the required
 * fields are missing or invalid.
 */
export function parseHermesSkillMd(content: string): ParsedHermesSkill {
  const normalized = content.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    throw new SkillParseError("SKILL.md must start with a `---` frontmatter fence");
  }
  const end = normalized.indexOf("\n---", 4);
  if (end === -1) throw new SkillParseError("frontmatter fence is not closed");

  const frontmatterText = normalized.slice(4, end);
  const body = normalized.slice(end + 4).replace(/^\n+/, "").trim();
  if (body.length === 0) throw new SkillParseError("SKILL.md body must not be empty");

  // Only top-level `key: scalar` lines; nested blocks/arrays are skipped.
  const scalars = new Map<string, string>();
  for (const line of frontmatterText.split("\n")) {
    if (line.trim().length === 0 || /^\s/.test(line) || line.trimStart().startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const rest = line.slice(colon + 1).trim();
    if (rest.length === 0 || rest.startsWith("[") || rest.startsWith("{")) continue;
    scalars.set(key, unquote(rest));
  }

  const name = scalars.get("name");
  if (name === undefined || name.length === 0 || name.length > 64 || !SKILL_NAME_RE.test(name)) {
    throw new SkillParseError(`invalid or missing frontmatter "name" (${name ?? "absent"})`);
  }
  const description = scalars.get("description");
  if (description === undefined || description.length === 0 || description.length > 1024) {
    throw new SkillParseError("missing or over-long frontmatter \"description\"");
  }
  const version = scalars.get("version") ?? "0.1.0";
  return { frontmatter: { name, description, version }, body };
}

function listResources(skillDir: string): string[] {
  const out: string[] = [];
  for (const dir of SKILL_SUPPORT_DIRS) {
    const root = join(skillDir, dir);
    if (!existsSync(root)) continue;
    const walk = (current: string): void => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const full = join(current, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) out.push(relative(skillDir, full));
      }
    };
    walk(root);
  }
  return out.sort();
}

interface UsageRecord {
  state?: string;
}

function readUsageStates(skillsDir: string): Map<string, string> {
  const states = new Map<string, string>();
  const usagePath = join(skillsDir, ".usage.json");
  if (!existsSync(usagePath)) return states;
  try {
    const parsed: unknown = JSON.parse(readFileSync(usagePath, "utf8"));
    const root = asRecord(parsed);
    if (root === undefined) return states;
    for (const [name, value] of Object.entries(root)) {
      const rec = asRecord(value) as UsageRecord | undefined;
      const state = rec === undefined ? undefined : asString(rec["state"]);
      if (state !== undefined) states.set(name, state);
    }
  } catch {
    // Corrupt sidecar: ignore, skills import enabled.
  }
  return states;
}

function findSkillFiles(skillsDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name === "SKILL.md") out.push(full);
    }
  };
  walk(skillsDir);
  return out.sort();
}

export interface HermesSkillsImportOptions extends ImportOptions {
  /** Root of the Hermes skills tree (e.g. `~/.hermes/skills`). */
  skillsDir: string;
  db: OmniDatabase;
  /** Receives each converted skill (the daemon routes it through skill-engine). */
  onSkill: (skill: SkillDefinition) => void | Promise<void>;
}

/** Convert every SKILL.md under `skillsDir` and pass it to `onSkill`. */
export async function importHermesSkills(
  options: HermesSkillsImportOptions,
): Promise<ImportReport> {
  const report = new ImportReportBuilder();
  const dryRun = options.dryRun ?? false;
  const tracker = new ImportStateTracker(options.db, "hermes.skills", dryRun);

  if (!existsSync(options.skillsDir) || !statSync(options.skillsDir).isDirectory()) {
    report.error(options.skillsDir, "skills directory does not exist");
    return report.finish();
  }

  const usageStates = readUsageStates(options.skillsDir);
  for (const filePath of findSkillFiles(options.skillsDir)) {
    let parsed: ParsedHermesSkill;
    try {
      parsed = parseHermesSkillMd(readFileSync(filePath, "utf8"));
    } catch (err) {
      report.error(filePath, errMessage(err));
      continue;
    }
    const { name } = parsed.frontmatter;
    const sourceKey = name;
    if (tracker.has(sourceKey)) {
      report.skip(sourceKey, `already imported as ${tracker.targetOf(sourceKey) ?? "?"}`);
      continue;
    }
    const skillId = `skill_hermes_${name}` as SkillId;
    const state = usageStates.get(name);
    const skill: SkillDefinition = {
      id: skillId,
      name,
      description: parsed.frontmatter.description,
      version: parsed.frontmatter.version,
      body: parsed.body,
      resources: listResources(join(filePath, "..")),
      requiredCapabilities: [],
      scope: "global",
      enabled: state !== "archived",
      dependencies: [],
      source: "imported",
      sourcePath: filePath,
      createdAt: nowIso(),
    };
    if (state === "archived") {
      report.warn(`skill "${name}" was archived in Hermes; imported disabled`);
    }
    if (!dryRun) {
      await options.onSkill(skill);
      tracker.mark(sourceKey, skillId);
    }
    report.imported();
  }
  return report.finish();
}
