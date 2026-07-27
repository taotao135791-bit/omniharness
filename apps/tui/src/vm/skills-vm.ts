import type { SkillDefinition, SkillProposal } from "@omniharness/agent-protocol";
import { truncate } from "./layout.js";
import { SelectableList, type ListRow } from "./selectable-list.js";

/** Skills view-model: installed skills + pending learned-skill proposals. */
export class SkillsViewModel {
  skills: SkillDefinition[] = [];
  proposals: SkillProposal[] = [];
  loading = false;
  error: string | null = null;
  readonly list = new SelectableList();

  setData(skills: SkillDefinition[], proposals: SkillProposal[]): void {
    this.skills = skills;
    this.proposals = proposals;
    this.loading = false;
    this.error = null;
    const rows: ListRow[] = [];
    if (proposals.length > 0) {
      rows.push({
        id: "h:proposals",
        label: `proposals (${proposals.length})`,
        detail: "",
        header: true,
      });
      for (const p of proposals) {
        rows.push({
          id: `prop:${p.id}`,
          label: `? ${p.skill.name} v${p.skill.version}`,
          detail: p.status,
        });
      }
    }
    rows.push({ id: "h:skills", label: `installed (${skills.length})`, detail: "", header: true });
    for (const s of skills) {
      rows.push({
        id: `skill:${s.id}`,
        label: `${s.enabled ? "●" : "○"} ${s.name}`,
        detail: `${s.scope} ${s.source} v${s.version}`,
      });
    }
    this.list.setRows(rows);
  }

  setError(message: string): void {
    this.loading = false;
    this.error = message;
  }

  selectedSkill(): SkillDefinition | undefined {
    const row = this.list.selectedRow();
    if (!row?.id.startsWith("skill:")) return undefined;
    return this.skills.find((s) => s.id === row.id.slice(6));
  }

  selectedProposal(): SkillProposal | undefined {
    const row = this.list.selectedRow();
    if (!row?.id.startsWith("prop:")) return undefined;
    return this.proposals.find((p) => p.id === row.id.slice(5));
  }

  renderLines(width: number, maxVisible: number): string[] {
    if (this.loading) return ["  loading skills…"];
    if (this.error) return [truncate(`  error: ${this.error}`, width)];
    if (this.skills.length === 0 && this.proposals.length === 0) return ["  no skills installed"];
    return this.list.renderLines(width, maxVisible);
  }
}
