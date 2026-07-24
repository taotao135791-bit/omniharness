import type { SkillStore } from "@omniharness/skill-engine";
import type { SkillDefinition, SkillId, SkillProposal } from "@omniharness/shared-types";
import type { OmniDatabase } from "@omniharness/session-store";

/** Backs the skill-engine's SkillStore with the daemon's SQLite database. */
export class SqliteSkillStore implements SkillStore {
  constructor(private readonly db: OmniDatabase) {}

  async save(skill: SkillDefinition): Promise<void> {
    this.db.skills.put(skill);
  }

  async get(id: SkillId): Promise<SkillDefinition | null> {
    return this.db.skills.get(id) ?? null;
  }

  async list(): Promise<SkillDefinition[]> {
    return this.db.skills.list();
  }

  async listByScope(scope: SkillDefinition["scope"]): Promise<SkillDefinition[]> {
    return this.db.skills.list().filter((s) => s.scope === scope);
  }

  async setEnabled(id: SkillId, enabled: boolean): Promise<void> {
    this.db.skills.setEnabled(id, enabled);
  }

  async delete(id: SkillId): Promise<void> {
    this.db.skills.delete(id);
  }

  async saveVersion(skill: SkillDefinition): Promise<void> {
    this.db.skills.archiveVersion(skill);
  }

  async listVersions(id: SkillId): Promise<SkillDefinition[]> {
    const current = this.db.skills.get(id);
    if (!current) return [];
    return this.db.skills.listVersions(id).map((v) => ({
      ...current,
      version: v.version,
      body: v.body,
      resources: v.resources,
      createdAt: v.createdAt,
    }));
  }

  async saveProposal(proposal: SkillProposal): Promise<void> {
    this.db.skills.putProposal(proposal);
  }

  async getProposal(id: string): Promise<SkillProposal | null> {
    return this.db.skills.getProposal(id) ?? null;
  }

  async listProposals(): Promise<SkillProposal[]> {
    return this.db.skills.listProposals();
  }
}
