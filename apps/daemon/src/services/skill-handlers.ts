import type { DaemonContext } from "../context.js";
import { nanoid } from "./id.js";
import type { SkillDefinition } from "@omniharness/shared-types";
import path from "node:path";
import { RpcError } from "../rpc-server.js";
import { ErrorCodes } from "@omniharness/agent-protocol";

type Register = (name: string, handler: (params: never) => unknown) => void;

/** Skill commands backed by the SkillEngine (SQLite store + learning loop). */
export function registerSkillHandlers(register: Register, ctx: DaemonContext): void {
  const { skills, bus } = ctx;

  register("skill.list", async (params: { enabledOnly?: boolean }) => {
    const all = await skills.listEffective();
    return { skills: params.enabledOnly ? all.filter((s) => s.enabled) : all };
  });

  register("skill.get", async (params: { skillId: string }) => {
    const skill = await skills.get(params.skillId as SkillDefinition["id"]);
    if (!skill) throw new RpcError(ErrorCodes.NOT_FOUND, "skill not found");
    return { skill };
  });

  register("skill.setEnabled", async (params: { skillId: string; enabled: boolean }) => {
    if (params.enabled) await skills.enable(params.skillId as SkillDefinition["id"]);
    else await skills.disable(params.skillId as SkillDefinition["id"]);
    return { ok: true as const };
  });

  register("skill.install", async (params: { source: string; ref: string; scope?: string }) => {
    if (params.source !== "local") {
      throw new RpcError(ErrorCodes.INVALID_PARAMS, `skill install source "${params.source}" not yet supported (local only)`);
    }
    const dir = path.resolve(params.ref);
    const skill = await skills.installFromDir(dir, {
      scope: (params.scope ?? "global") as SkillDefinition["scope"],
      source: "local",
    });
    return { skill };
  });

  register("skill.proposals", async (params: { status?: string }) => {
    const proposals = await skills.listProposals();
    return { proposals: params.status ? proposals.filter((p) => p.status === params.status) : proposals };
  });

  register("skill.approveProposal", async (params: { proposalId: string }) => {
    const skill = await skills.approveProposal(params.proposalId);
    bus.emit({ type: "skill.approved", skillId: skill.id });
    return { skill };
  });

  register("skill.rejectProposal", async (params: { proposalId: string; reason?: string }) => {
    await skills.rejectProposal(params.proposalId, params.reason ?? "");
    bus.emit({ type: "skill.rejected", proposalId: params.proposalId });
    return { ok: true as const };
  });
}
