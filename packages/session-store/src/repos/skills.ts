import type { DatabaseSync } from "node:sqlite";
import type {
  IsoTimestamp,
  SkillDefinition,
  SkillId,
  SkillProposal,
  SkillProposalStatus,
} from "@omniharness/shared-types";
import { nowIso } from "@omniharness/shared-types";
import { allRows, bit, bool, getRow, jparse, jstr, num } from "../helpers.js";

interface SkillRow {
  id: string;
  name: string;
  description: string;
  version: string;
  body: string;
  resources: string;
  required_capabilities: string;
  scope: string;
  enabled: number;
  dependencies: string;
  source: string;
  source_path: string | null;
  created_at: string;
}

function rowToSkill(r: SkillRow): SkillDefinition {
  const skill: SkillDefinition = {
    id: r.id as SkillId,
    name: r.name,
    description: r.description,
    version: r.version,
    body: r.body,
    resources: jparse<string[]>(r.resources, []),
    requiredCapabilities: jparse<SkillDefinition["requiredCapabilities"]>(
      r.required_capabilities,
      [],
    ),
    scope: r.scope as SkillDefinition["scope"],
    enabled: bool(r.enabled),
    dependencies: jparse<string[]>(r.dependencies, []),
    source: r.source as SkillDefinition["source"],
    createdAt: r.created_at,
  };
  if (r.source_path !== null) skill.sourcePath = r.source_path;
  return skill;
}

export interface SkillVersionRecord {
  skillId: SkillId;
  version: string;
  body: string;
  resources: string[];
  createdAt: IsoTimestamp;
}

export class SkillsRepo {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /**
   * Upsert a skill. When an existing row's version/body changes, the previous
   * version is archived into skill_versions first.
   */
  put(skill: SkillDefinition): void {
    const existing = this.get(skill.id);
    if (existing !== undefined && existing.version !== skill.version) {
      this.archiveVersion(existing);
    }
    this.db
      .prepare(
        `INSERT INTO skills
           (id, name, description, version, body, resources, required_capabilities, scope, enabled, dependencies, source, source_path, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, description = excluded.description, version = excluded.version,
           body = excluded.body, resources = excluded.resources,
           required_capabilities = excluded.required_capabilities, scope = excluded.scope,
           enabled = excluded.enabled, dependencies = excluded.dependencies,
           source = excluded.source, source_path = excluded.source_path`,
      )
      .run(
        skill.id,
        skill.name,
        skill.description,
        skill.version,
        skill.body,
        jstr(skill.resources),
        jstr(skill.requiredCapabilities),
        skill.scope,
        bit(skill.enabled),
        jstr(skill.dependencies),
        skill.source,
        skill.sourcePath ?? null,
        skill.createdAt,
      );
  }

  /** Explicitly snapshot a skill version into skill_versions (idempotent). */
  archiveVersion(skill: SkillDefinition): void {
    this.db
      .prepare(
        `INSERT INTO skill_versions (skill_id, version, body, resources, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(skill_id, version) DO UPDATE SET
           body = excluded.body, resources = excluded.resources`,
      )
      .run(skill.id, skill.version, skill.body, jstr(skill.resources), nowIso());
  }

  get(id: SkillId): SkillDefinition | undefined {
    const row = getRow<SkillRow>(this.db.prepare("SELECT * FROM skills WHERE id = ?"), id);
    return row === undefined ? undefined : rowToSkill(row);
  }

  list(enabledOnly = false): SkillDefinition[] {
    const rows = enabledOnly
      ? allRows<SkillRow>(
          this.db.prepare("SELECT * FROM skills WHERE enabled = 1 ORDER BY name, version"),
        )
      : allRows<SkillRow>(this.db.prepare("SELECT * FROM skills ORDER BY name, version"));
    return rows.map(rowToSkill);
  }

  listVersions(skillId: SkillId): SkillVersionRecord[] {
    interface VersionRow {
      version: string;
      body: string;
      resources: string;
      created_at: string;
    }
    return allRows<VersionRow>(
      this.db.prepare(
        "SELECT version, body, resources, created_at FROM skill_versions WHERE skill_id = ? ORDER BY created_at, version",
      ),
      skillId,
    ).map((r) => ({
      skillId,
      version: r.version,
      body: r.body,
      resources: jparse<string[]>(r.resources, []),
      createdAt: r.created_at,
    }));
  }

  setEnabled(id: SkillId, enabled: boolean): boolean {
    return (
      this.db.prepare("UPDATE skills SET enabled = ? WHERE id = ?").run(bit(enabled), id).changes >
      0
    );
  }

  delete(id: SkillId): boolean {
    return this.db.prepare("DELETE FROM skills WHERE id = ?").run(id).changes > 0;
  }

  // ---- proposals ----

  putProposal(proposal: SkillProposal): void {
    this.db
      .prepare(
        `INSERT INTO skill_proposals (id, skill, diff, based_on_session_id, status, test_result, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           skill = excluded.skill, diff = excluded.diff, status = excluded.status,
           test_result = excluded.test_result`,
      )
      .run(
        proposal.id,
        jstr(proposal.skill),
        proposal.diff,
        proposal.basedOnSessionId,
        proposal.status,
        proposal.testResult === undefined ? null : jstr(proposal.testResult),
        proposal.createdAt,
      );
  }

  getProposal(id: string): SkillProposal | undefined {
    interface ProposalRow {
      id: string;
      skill: string;
      diff: string | null;
      based_on_session_id: string;
      status: string;
      test_result: string | null;
      created_at: string;
    }
    const row = getRow<ProposalRow>(
      this.db.prepare("SELECT * FROM skill_proposals WHERE id = ?"),
      id,
    );
    if (row === undefined) return undefined;
    const proposal: SkillProposal = {
      id: row.id,
      skill: jparse<SkillDefinition>(row.skill, {} as SkillDefinition),
      diff: row.diff,
      basedOnSessionId: row.based_on_session_id,
      status: row.status as SkillProposalStatus,
      createdAt: row.created_at,
    };
    if (row.test_result !== null) {
      proposal.testResult = jparse<NonNullable<SkillProposal["testResult"]>>(row.test_result, {
        passed: false,
        output: "",
      });
    }
    return proposal;
  }

  listProposals(status?: SkillProposalStatus): SkillProposal[] {
    interface IdRow {
      id: string;
    }
    const ids = (
      status === undefined
        ? allRows<IdRow>(this.db.prepare("SELECT id FROM skill_proposals ORDER BY created_at, id"))
        : allRows<IdRow>(
            this.db.prepare(
              "SELECT id FROM skill_proposals WHERE status = ? ORDER BY created_at, id",
            ),
            status,
          )
    ).map((r) => r.id);
    const out: SkillProposal[] = [];
    for (const id of ids) {
      const p = this.getProposal(id);
      if (p !== undefined) out.push(p);
    }
    return out;
  }

  deleteProposal(id: string): boolean {
    return this.db.prepare("DELETE FROM skill_proposals WHERE id = ?").run(id).changes > 0;
  }
}
