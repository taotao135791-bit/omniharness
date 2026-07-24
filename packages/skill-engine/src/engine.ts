import { promises as fs } from "node:fs";
import path from "node:path";
import { validateSkillDefinition } from "@omniharness/config-schema";
import type {
  Capability,
  IsoTimestamp,
  SkillDefinition,
  SkillId,
  SkillProposal,
} from "@omniharness/shared-types";
import { ALL_CAPABILITIES, nowIso } from "@omniharness/shared-types";
import { parseSkillMd, serializeSkillMd, SkillMdParseError } from "./parser.js";
import type { SkillScope, SkillStore } from "./store.js";

export class SkillEngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillEngineError";
  }
}

export interface InstallOptions {
  scope: SkillScope;
  source: SkillDefinition["source"];
  /** Defaults to true for ordinary installs; learned skills install disabled. */
  enabled?: boolean;
}

export interface SessionSummary {
  sessionId: string;
  /** Free-text recap of what the session accomplished. */
  summary: string;
  suggestedName?: string;
  scope?: SkillScope;
}

export interface ProposalTestResult {
  passed: boolean;
  output: string;
}

export type ProposalRunner = (
  skill: SkillDefinition,
) => Promise<ProposalTestResult> | ProposalTestResult;

export interface SkillEngineOptions {
  now?: () => IsoTimestamp;
  idGen?: (prefix: string) => string;
}

const SCOPE_RANK: Record<SkillScope, number> = {
  global: 0,
  profile: 1,
  workspace: 2,
  project: 3,
};

function defaultIdGen(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .filter((part) => part.length > 0)
    .slice(0, 5)
    .join("-");
  return slug.length > 0 ? slug : "skill";
}

function bumpVersion(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (match === null) return `${version}.1`;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return `${major}.${minor}.${patch + 1}`;
}

/** Minimal line diff: common prefix/suffix kept, changed middle marked -/+. */
export function diffBodies(oldBody: string, newBody: string): string | null {
  if (oldBody === newBody) return null;
  const oldLines = oldBody.split("\n");
  const newLines = newBody.split("\n");
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const removed = oldLines.slice(prefix, oldLines.length - suffix);
  const added = newLines.slice(prefix, newLines.length - suffix);
  const out = ["--- a/SKILL.md", "+++ b/SKILL.md", "@@"];
  for (const line of removed) out.push(`- ${line}`);
  for (const line of added) out.push(`+ ${line}`);
  return out.join("\n");
}

async function walkFiles(dir: string, base: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(abs, base)));
    } else if (entry.isFile()) {
      files.push(path.relative(base, abs));
    }
  }
  return files;
}

export class SkillEngine {
  private readonly now: () => IsoTimestamp;
  private readonly idGen: (prefix: string) => string;
  private readonly rejectionReasons = new Map<string, string>();

  constructor(
    private readonly store: SkillStore,
    options: SkillEngineOptions = {},
  ) {
    this.now = options.now ?? nowIso;
    this.idGen = options.idGen ?? defaultIdGen;
  }

  /** Install a skill from a local directory containing a SKILL.md. */
  async installFromDir(dir: string, options: InstallOptions): Promise<SkillDefinition> {
    const skillMdPath = path.join(dir, "SKILL.md");
    let content: string;
    try {
      content = await fs.readFile(skillMdPath, "utf8");
    } catch {
      throw new SkillEngineError(`no SKILL.md found in ${dir}`);
    }
    const parsed = parseSkillMd(content);
    const resources = (await walkFiles(dir, dir)).filter((rel) => rel !== "SKILL.md").sort();

    const skill: SkillDefinition = {
      id: this.idGen("skl") as SkillId,
      name: parsed.name,
      description: parsed.description,
      version: parsed.version,
      body: parsed.body,
      resources,
      requiredCapabilities: parsed.requiredCapabilities,
      scope: options.scope,
      enabled: options.enabled ?? true,
      dependencies: parsed.dependencies,
      source: options.source,
      sourcePath: dir,
      createdAt: this.now(),
    };
    this.assertValid(skill);
    await this.store.save(skill);
    await this.store.saveVersion(skill);
    return skill;
  }

  private assertValid(skill: SkillDefinition): void {
    const issues = validateSkillDefinition(skill);
    if (issues.length > 0) {
      const detail = issues.map((i) => `${i.path}: ${i.message}`).join("; ");
      throw new SkillEngineError(`invalid skill definition: ${detail}`);
    }
    const known = new Set<string>(ALL_CAPABILITIES);
    const unknown = skill.requiredCapabilities.filter((cap: Capability) => !known.has(cap));
    if (unknown.length > 0) {
      throw new SkillEngineError(`unknown capabilities: ${unknown.join(", ")}`);
    }
  }

  async enable(id: SkillId): Promise<void> {
    await this.requireSkill(id);
    await this.store.setEnabled(id, true);
  }

  async disable(id: SkillId): Promise<void> {
    await this.requireSkill(id);
    await this.store.setEnabled(id, false);
  }

  async uninstall(id: SkillId): Promise<void> {
    await this.requireSkill(id);
    await this.store.delete(id);
  }

  async get(id: SkillId): Promise<SkillDefinition | null> {
    return this.store.get(id);
  }

  async list(filter?: { scope?: SkillScope }): Promise<SkillDefinition[]> {
    if (filter?.scope !== undefined) return this.store.listByScope(filter.scope);
    return this.store.list();
  }

  /**
   * Effective skill set across scopes: when skills share a name, the one from
   * the higher-precedence scope (project > workspace > profile > global)
   * shadows the rest.
   */
  async listEffective(): Promise<SkillDefinition[]> {
    const all = await this.store.list();
    const byName = new Map<string, SkillDefinition>();
    for (const skill of all) {
      const existing = byName.get(skill.name);
      if (existing === undefined || SCOPE_RANK[skill.scope] > SCOPE_RANK[existing.scope]) {
        byName.set(skill.name, skill);
      }
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async listVersions(id: SkillId): Promise<SkillDefinition[]> {
    return this.store.listVersions(id);
  }

  // ------------------------------------------------------------------
  // Learning loop (approval-gated: proposals never auto-activate)
  // ------------------------------------------------------------------

  async proposeFromSession(summary: SessionSummary): Promise<SkillProposal> {
    const text = summary.summary.trim();
    if (text.length === 0) {
      throw new SkillEngineError("session summary must not be empty");
    }
    const name = summary.suggestedName ?? `learned-${slugify(text)}`;
    const scope = summary.scope ?? "profile";
    const firstSentence = (text.split(/(?<=[.!?])\s/)[0] ?? text).slice(0, 60);
    const body = [
      `# ${name}`,
      "",
      "## When to Use",
      "",
      firstSentence,
      "",
      "## Procedure",
      "",
      text,
      "",
      "## Verification",
      "",
      "Re-run the steps above and confirm the outcome matches the session result.",
    ].join("\n");

    const draft: SkillDefinition = {
      id: this.idGen("skl") as SkillId,
      name,
      description: firstSentence,
      version: "0.1.0",
      body,
      resources: [],
      requiredCapabilities: [],
      scope,
      enabled: false,
      dependencies: [],
      source: "learned",
      createdAt: this.now(),
    };

    const existing = await this.findLearnedByName(name, scope);
    const diff = existing === null ? null : diffBodies(existing.body, draft.body);

    const proposal: SkillProposal = {
      id: this.idGen("skp"),
      skill: draft,
      diff,
      basedOnSessionId: summary.sessionId,
      status: "pending",
      createdAt: this.now(),
    };
    await this.store.saveProposal(proposal);
    return proposal;
  }

  async testProposal(id: string, runner: ProposalRunner): Promise<SkillProposal> {
    const proposal = await this.requireProposal(id);
    if (proposal.status !== "pending") {
      throw new SkillEngineError(`proposal ${id} is ${proposal.status}, cannot test`);
    }
    proposal.status = "testing";
    await this.store.saveProposal(proposal);
    try {
      const result = await runner(proposal.skill);
      proposal.testResult = { passed: result.passed, output: result.output };
    } catch (error) {
      proposal.testResult = {
        passed: false,
        output: error instanceof Error ? error.message : String(error),
      };
    }
    proposal.status = "pending";
    await this.store.saveProposal(proposal);
    return proposal;
  }

  /**
   * Approve a proposal and install it as a learned skill. The skill is always
   * installed DISABLED — proposals never auto-activate. If a learned skill
   * with the same name+scope exists, its version is bumped and the old
   * version is kept in version history.
   */
  async approveProposal(id: string): Promise<SkillDefinition> {
    const proposal = await this.requireProposal(id);
    if (proposal.status !== "pending") {
      throw new SkillEngineError(`proposal ${id} is ${proposal.status}, cannot approve`);
    }
    const existing = await this.findLearnedByName(proposal.skill.name, proposal.skill.scope);
    let installed: SkillDefinition;
    if (existing === null) {
      installed = { ...proposal.skill, enabled: false };
      await this.store.save(installed);
      await this.store.saveVersion(installed);
    } else {
      await this.store.saveVersion(existing);
      installed = {
        ...existing,
        description: proposal.skill.description,
        body: proposal.skill.body,
        version: bumpVersion(existing.version),
        enabled: existing.enabled,
      };
      await this.store.save(installed);
    }
    proposal.status = "approved";
    await this.store.saveProposal(proposal);
    return installed;
  }

  async rejectProposal(id: string, reason: string): Promise<SkillProposal> {
    const proposal = await this.requireProposal(id);
    if (proposal.status !== "pending") {
      throw new SkillEngineError(`proposal ${id} is ${proposal.status}, cannot reject`);
    }
    proposal.status = "rejected";
    await this.store.saveProposal(proposal);
    this.rejectionReasons.set(id, reason);
    return proposal;
  }

  /** Rejection reason for a rejected proposal, if rejected via this engine. */
  rejectionReason(id: string): string | null {
    return this.rejectionReasons.get(id) ?? null;
  }

  async listProposals(): Promise<SkillProposal[]> {
    return this.store.listProposals();
  }

  // ------------------------------------------------------------------
  // Import / export
  // ------------------------------------------------------------------

  /**
   * Export a skill as a tarball-ready folder: SKILL.md regenerated from the
   * definition, plus its resource files copied from the source directory
   * (when the skill was installed from a local path).
   */
  async exportSkill(id: SkillId, destDir: string): Promise<void> {
    const skill = await this.requireSkill(id);
    await fs.mkdir(destDir, { recursive: true });
    await fs.writeFile(path.join(destDir, "SKILL.md"), serializeSkillMd(skill), "utf8");
    if (skill.sourcePath === undefined) return;
    const base = path.resolve(skill.sourcePath);
    for (const rel of skill.resources) {
      const src = path.resolve(base, rel);
      if (!src.startsWith(base + path.sep)) {
        throw new SkillEngineError(`resource escapes skill directory: ${rel}`);
      }
      const dest = path.join(destDir, rel);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(src, dest);
    }
  }

  /** Import Pi-format skills from `.pi/skills/*` and `.agents/skills/*`. */
  async importPiSkills(dir: string, options?: { scope?: SkillScope }): Promise<SkillDefinition[]> {
    const installed: SkillDefinition[] = [];
    for (const container of [".pi/skills", ".agents/skills"]) {
      const containerDir = path.join(dir, container);
      let entries;
      try {
        entries = await fs.readdir(containerDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillDir = path.join(containerDir, entry.name);
        try {
          await fs.stat(path.join(skillDir, "SKILL.md"));
        } catch {
          continue;
        }
        installed.push(
          await this.installFromDir(skillDir, {
            scope: options?.scope ?? "profile",
            source: "imported",
          }),
        );
      }
    }
    return installed;
  }

  /**
   * Import Hermes skills from `skills/**\/SKILL.md` (recursive). A `.usage.json`
   * sidecar next to a SKILL.md is read for existence only — its counters are
   * ignored and the skill is marked with source "imported".
   */
  async importHermesSkills(
    dir: string,
    options?: { scope?: SkillScope },
  ): Promise<SkillDefinition[]> {
    const skillsRoot = path.join(dir, "skills");
    let files: string[];
    try {
      files = await walkFiles(skillsRoot, skillsRoot);
    } catch {
      return [];
    }
    const installed: SkillDefinition[] = [];
    for (const rel of files.sort()) {
      if (path.basename(rel) !== "SKILL.md") continue;
      const skillDir = path.join(skillsRoot, path.dirname(rel));
      const usagePath = path.join(skillDir, ".usage.json");
      try {
        await fs.readFile(usagePath, "utf8"); // sidecar noted, counters ignored
      } catch {
        // no sidecar — fine
      }
      installed.push(
        await this.installFromDir(skillDir, {
          scope: options?.scope ?? "profile",
          source: "imported",
        }),
      );
    }
    return installed;
  }

  // ------------------------------------------------------------------

  private async findLearnedByName(
    name: string,
    scope: SkillScope,
  ): Promise<SkillDefinition | null> {
    const all = await this.store.listByScope(scope);
    return all.find((s) => s.name === name && s.source === "learned") ?? null;
  }

  private async requireSkill(id: SkillId): Promise<SkillDefinition> {
    const skill = await this.store.get(id);
    if (skill === null) throw new SkillEngineError(`unknown skill: ${id}`);
    return skill;
  }

  private async requireProposal(id: string): Promise<SkillProposal> {
    const proposal = await this.store.getProposal(id);
    if (proposal === null) throw new SkillEngineError(`unknown proposal: ${id}`);
    return proposal;
  }
}

export { SkillMdParseError };
