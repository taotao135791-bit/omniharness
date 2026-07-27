import type { CommandName, CommandParams, CommandResult } from "@omniharness/agent-protocol";

/** The slice of OmniClient the controller and view-models depend on. */
export interface DaemonApi {
  call<N extends CommandName>(name: N, params: CommandParams<N>): Promise<CommandResult<N>>;
}

export type ViewName =
  | "sessions"
  | "chat"
  | "diff"
  | "models"
  | "approvals"
  | "memory"
  | "skills"
  | "automations"
  | "logs"
  | "settings";

export const VIEW_TITLES: Record<ViewName, string> = {
  sessions: "Sessions",
  chat: "Chat",
  diff: "Diff",
  models: "Models",
  approvals: "Approvals",
  memory: "Memory",
  skills: "Skills",
  automations: "Automations",
  logs: "Logs",
  settings: "Settings",
};

export type ConnectionState = "connected" | "disconnected" | "replaying";

export type ApprovalScope = "once" | "session" | "workspace" | "always";

/** rememberScope values passed to approval.resolve, per scope choice. */
export const APPROVAL_SCOPE_RPC: Record<Exclude<ApprovalScope, "once">, string> = {
  session: "ask_once_per_session",
  workspace: "allow_for_workspace",
  always: "always_allow",
};
