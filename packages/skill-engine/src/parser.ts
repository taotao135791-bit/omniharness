import type { Capability } from "@omniharness/shared-types";
import { ALL_CAPABILITIES } from "@omniharness/shared-types";
import { parseFrontmatter, serializeFrontmatter, type Frontmatter } from "./frontmatter.js";

/** The parsed contents of a SKILL.md file (agentskills.io-style). */
export interface ParsedSkillMd {
  name: string;
  description: string;
  version: string;
  requiredCapabilities: Capability[];
  dependencies: string[];
  /** Markdown body below the frontmatter fence. */
  body: string;
}

export class SkillMdParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillMdParseError";
  }
}

function requireString(frontmatter: Frontmatter, key: string): string {
  const value = frontmatter[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SkillMdParseError(`SKILL.md frontmatter requires a non-empty string "${key}"`);
  }
  return value;
}

function optionalStringArray(frontmatter: Frontmatter, key: string): string[] {
  const value = frontmatter[key];
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new SkillMdParseError(`SKILL.md frontmatter "${key}" must be a string array`);
  }
  return value;
}

/**
 * Split a SKILL.md document into frontmatter + body and validate the fields
 * we rely on. Throws SkillMdParseError on malformed input.
 */
export function parseSkillMd(content: string): ParsedSkillMd {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    throw new SkillMdParseError("SKILL.md must start with a `---` frontmatter fence");
  }
  const end = normalized.indexOf("\n---", 4);
  if (end === -1) {
    throw new SkillMdParseError("SKILL.md frontmatter fence is not closed");
  }
  const afterFence = normalized.slice(end + 4);
  if (!afterFence.startsWith("\n") && afterFence.trim().length > 0) {
    throw new SkillMdParseError("malformed frontmatter closing fence");
  }
  const frontmatter = parseFrontmatter(normalized.slice(4, end));
  const body = afterFence.replace(/^\n/, "").trim();
  if (body.length === 0) {
    throw new SkillMdParseError("SKILL.md body must not be empty");
  }

  const capabilities = optionalStringArray(frontmatter, "requiredCapabilities");
  const known = new Set<string>(ALL_CAPABILITIES);
  const unknown = capabilities.filter((cap) => !known.has(cap));
  if (unknown.length > 0) {
    throw new SkillMdParseError(`unknown capabilities: ${unknown.join(", ")}`);
  }

  return {
    name: requireString(frontmatter, "name"),
    description: requireString(frontmatter, "description"),
    version: typeof frontmatter["version"] === "string" ? frontmatter["version"] : "0.1.0",
    requiredCapabilities: capabilities as Capability[],
    dependencies: optionalStringArray(frontmatter, "dependencies"),
    body,
  };
}

/** Serialize a skill's metadata + body back to a SKILL.md document. */
export function serializeSkillMd(skill: {
  name: string;
  description: string;
  version: string;
  requiredCapabilities: Capability[];
  dependencies: string[];
  body: string;
}): string {
  const frontmatter: Frontmatter = {
    name: skill.name,
    description: skill.description,
    version: skill.version,
  };
  if (skill.requiredCapabilities.length > 0) {
    frontmatter["requiredCapabilities"] = [...skill.requiredCapabilities];
  }
  if (skill.dependencies.length > 0) {
    frontmatter["dependencies"] = [...skill.dependencies];
  }
  return `---\n${serializeFrontmatter(frontmatter)}\n---\n\n${skill.body.trim()}\n`;
}
