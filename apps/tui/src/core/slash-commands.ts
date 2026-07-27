import type { AppController } from "./app-controller.js";

export interface SlashCommand {
  name: string;
  usage: string;
  description: string;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: "model", usage: "/model [model-id]", description: "Show or switch the primary model" },
  { name: "session", usage: "/session new|rename|archive", description: "Manage the current session" },
  { name: "diff", usage: "/diff", description: "Review pending changes" },
  { name: "checkpoint", usage: "/checkpoint create|restore [label|id]", description: "Manage checkpoints" },
  { name: "interrupt", usage: "/interrupt", description: "Interrupt the active run" },
  { name: "enqueue", usage: "/enqueue <text>", description: "Queue a follow-up message" },
  { name: "compact-status", usage: "/compact-status", description: "Show context/compaction status" },
  { name: "skills", usage: "/skills", description: "Open the skills view" },
  { name: "memory", usage: "/memory", description: "Open the memory view" },
  { name: "usage", usage: "/usage", description: "Show token/cost usage" },
  { name: "help", usage: "/help", description: "List commands" },
];

export function helpText(): string {
  const lines = ["available commands:"];
  for (const c of SLASH_COMMANDS) lines.push(`  ${c.usage.padEnd(38)} ${c.description}`);
  lines.push("  ctrl+p opens the command palette for everything else");
  return lines.join("\n");
}

/**
 * Dispatch a slash command typed into the chat input.
 * Returns false when the command name is unknown (caller shows a hint).
 */
export async function executeSlashCommand(
  controller: AppController,
  input: string,
): Promise<boolean> {
  const [head, ...rest] = input.slice(1).split(/\s+/);
  const arg = rest.join(" ").trim();
  const chat = controller.chat;

  switch (head) {
    case "model": {
      if (!arg) {
        await controller.setView("models");
        return true;
      }
      await controller.setRoleBinding("primary", arg);
      return true;
    }
    case "session": {
      const [sub, ...subRest] = rest;
      const subArg = subRest.join(" ").trim();
      if (sub === "new") {
        if (!controller.currentSession) {
          chat.addSystemMessage("no current session to derive a workspace from — use ctrl+n in the sessions view");
          return true;
        }
        const session = await controller.createSession(
          controller.currentSession.workspaceId,
          subArg || undefined,
        );
        await controller.openSession(session.id);
        return true;
      }
      if (sub === "rename") {
        if (!controller.currentSession || !subArg) {
          chat.addSystemMessage("usage: /session rename <title>");
          return true;
        }
        await controller.renameSession(controller.currentSession.id, subArg);
        return true;
      }
      if (sub === "archive") {
        if (!controller.currentSession) {
          chat.addSystemMessage("no session open");
          return true;
        }
        const id = controller.currentSession.id;
        await controller.archiveSession(id);
        chat.addSystemMessage("session archived");
        await controller.setView("sessions");
        return true;
      }
      chat.addSystemMessage("usage: /session new [title] | rename <title> | archive");
      return true;
    }
    case "diff":
      await controller.setView("diff");
      return true;
    case "checkpoint": {
      const [sub, ...subRest] = rest;
      const subArg = subRest.join(" ").trim();
      if (sub === "create") {
        await controller.createCheckpoint(subArg || undefined);
        return true;
      }
      if (sub === "restore") {
        if (subArg) {
          await controller.restoreCheckpoint(subArg);
          return true;
        }
        const checkpoints = await controller.listCheckpoints();
        if (checkpoints.length === 0) chat.addSystemMessage("no checkpoints for this session");
        else
          chat.addSystemMessage(
            `checkpoints:\n${checkpoints.map((c) => `  ${c.id}  ${c.label}  ${c.kind}`).join("\n")}\nrestore with /checkpoint restore <id>`,
          );
        return true;
      }
      chat.addSystemMessage("usage: /checkpoint create [label] | restore [id]");
      return true;
    }
    case "interrupt":
      await controller.interrupt();
      return true;
    case "enqueue":
      if (!arg) chat.addSystemMessage("usage: /enqueue <text>");
      else await controller.enqueueFollowUp(arg);
      return true;
    case "compact-status":
      chat.addSystemMessage(controller.compactionStatusText());
      return true;
    case "skills":
      await controller.setView("skills");
      return true;
    case "memory":
      await controller.setView("memory");
      return true;
    case "usage":
      chat.addSystemMessage(await controller.usageSummaryText());
      return true;
    case "help":
      chat.addSystemMessage(helpText());
      return true;
    default:
      return false;
  }
}
