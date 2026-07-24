import type { SkillDefinition, SkillProposal } from "@omniharness/shared-types";
import type { SkillId } from "@omniharness/shared-types";

export type SkillScope = SkillDefinition["scope"];

/**
 * Persistence boundary for the skill engine. The daemon backs this with
 * SQLite; tests and ephemeral runtimes use InMemorySkillStore. All methods
 * are async so a database-backed implementation is a drop-in replacement.
 */
export interface SkillStore {
  save(skill: SkillDefinition): Promise<void>;
  get(id: SkillId): Promise<SkillDefinition | null>;
  list(): Promise<SkillDefinition[]>;
  listByScope(scope: SkillScope): Promise<SkillDefinition[]>;
  setEnabled(id: SkillId, enabled: boolean): Promise<void>;
  delete(id: SkillId): Promise<void>;
  /** Append a snapshot of a skill version to its history. */
  saveVersion(skill: SkillDefinition): Promise<void>;
  /** Version history for a skill, oldest first. */
  listVersions(id: SkillId): Promise<SkillDefinition[]>;

  saveProposal(proposal: SkillProposal): Promise<void>;
  getProposal(id: string): Promise<SkillProposal | null>;
  listProposals(): Promise<SkillProposal[]>;
}

function cloneSkill(skill: SkillDefinition): SkillDefinition {
  return structuredClone(skill);
}

function cloneProposal(proposal: SkillProposal): SkillProposal {
  return structuredClone(proposal);
}

/** Reference in-memory SkillStore. */
export class InMemorySkillStore implements SkillStore {
  private readonly skills = new Map<SkillId, SkillDefinition>();
  private readonly versions = new Map<SkillId, SkillDefinition[]>();
  private readonly proposals = new Map<string, SkillProposal>();

  save(skill: SkillDefinition): Promise<void> {
    this.skills.set(skill.id, cloneSkill(skill));
    return Promise.resolve();
  }

  get(id: SkillId): Promise<SkillDefinition | null> {
    const skill = this.skills.get(id);
    return Promise.resolve(skill === undefined ? null : cloneSkill(skill));
  }

  list(): Promise<SkillDefinition[]> {
    return Promise.resolve([...this.skills.values()].map(cloneSkill));
  }

  listByScope(scope: SkillScope): Promise<SkillDefinition[]> {
    return Promise.resolve(
      [...this.skills.values()].filter((s) => s.scope === scope).map(cloneSkill),
    );
  }

  setEnabled(id: SkillId, enabled: boolean): Promise<void> {
    const skill = this.skills.get(id);
    if (skill !== undefined) skill.enabled = enabled;
    return Promise.resolve();
  }

  delete(id: SkillId): Promise<void> {
    this.skills.delete(id);
    return Promise.resolve();
  }

  saveVersion(skill: SkillDefinition): Promise<void> {
    const history = this.versions.get(skill.id) ?? [];
    history.push(cloneSkill(skill));
    this.versions.set(skill.id, history);
    return Promise.resolve();
  }

  listVersions(id: SkillId): Promise<SkillDefinition[]> {
    return Promise.resolve((this.versions.get(id) ?? []).map(cloneSkill));
  }

  saveProposal(proposal: SkillProposal): Promise<void> {
    this.proposals.set(proposal.id, cloneProposal(proposal));
    return Promise.resolve();
  }

  getProposal(id: string): Promise<SkillProposal | null> {
    const proposal = this.proposals.get(id);
    return Promise.resolve(proposal === undefined ? null : cloneProposal(proposal));
  }

  listProposals(): Promise<SkillProposal[]> {
    return Promise.resolve([...this.proposals.values()].map(cloneProposal));
  }
}
