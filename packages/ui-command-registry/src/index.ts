/**
 * Unified command registry: every user-invokable action is declared once here
 * and surfaced in the TUI command palette, TUI keybindings, GUI menus and GUI
 * command palette. Commands map to daemon RPC calls via client-sdk.
 */

export interface CommandSpec {
  /** Stable id, e.g. "session.rename". Matches RPC command names where applicable. */
  id: string;
  title: string;
  /** Palette category / menu group. */
  category:
    | "session"
    | "agent"
    | "model"
    | "workspace"
    | "tool"
    | "memory"
    | "skill"
    | "automation"
    | "plugin"
    | "view"
    | "system";
  /** Default keybinding (TUI notation, e.g. "ctrl+r"; GUI maps separately). */
  keybinding?: string;
  /** Whether the command needs an active session. */
  requiresSession?: boolean;
  /** Which daemon RPC it invokes, if any (UI-only commands omit this). */
  rpc?: string;
}

export const COMMANDS: readonly CommandSpec[] = [
  {
    id: "session.new",
    title: "New session",
    category: "session",
    keybinding: "ctrl+n",
    rpc: "session.create",
  },
  {
    id: "session.rename",
    title: "Rename session",
    category: "session",
    requiresSession: true,
    rpc: "session.rename",
  },
  {
    id: "session.archive",
    title: "Archive session",
    category: "session",
    requiresSession: true,
    rpc: "session.archive",
  },
  {
    id: "session.branch",
    title: "Branch from message",
    category: "session",
    requiresSession: true,
    rpc: "session.branch",
  },
  {
    id: "session.export",
    title: "Export session",
    category: "session",
    requiresSession: true,
    rpc: "session.export",
  },
  {
    id: "session.import",
    title: "Import session (Pi/Hermes)",
    category: "session",
    rpc: "session.import",
  },
  {
    id: "agent.interrupt",
    title: "Interrupt run",
    category: "agent",
    keybinding: "esc",
    requiresSession: true,
    rpc: "run.interrupt",
  },
  {
    id: "agent.resume",
    title: "Resume run",
    category: "agent",
    requiresSession: true,
    rpc: "run.resume",
  },
  {
    id: "agent.retry",
    title: "Retry run",
    category: "agent",
    requiresSession: true,
    rpc: "run.retry",
  },
  {
    id: "agent.steer",
    title: "Steer running agent",
    category: "agent",
    requiresSession: true,
    rpc: "run.steer",
  },
  {
    id: "model.switch",
    title: "Switch model",
    category: "model",
    keybinding: "ctrl+m",
    rpc: "model.setRoleBinding",
  },
  {
    id: "model.bindings",
    title: "Edit role bindings",
    category: "model",
    rpc: "model.getRoleBindings",
  },
  { id: "provider.add", title: "Add provider", category: "model", rpc: "provider.add" },
  { id: "provider.test", title: "Test provider", category: "model", rpc: "provider.test" },
  {
    id: "diff.review",
    title: "Review diff",
    category: "workspace",
    keybinding: "ctrl+d",
    requiresSession: true,
    rpc: "diff.get",
  },
  {
    id: "diff.acceptAll",
    title: "Accept all changes",
    category: "workspace",
    requiresSession: true,
    rpc: "diff.accept",
  },
  {
    id: "diff.rejectAll",
    title: "Reject all changes",
    category: "workspace",
    requiresSession: true,
    rpc: "diff.reject",
  },
  {
    id: "checkpoint.create",
    title: "Create checkpoint",
    category: "workspace",
    requiresSession: true,
    rpc: "checkpoint.create",
  },
  {
    id: "checkpoint.restore",
    title: "Restore checkpoint",
    category: "workspace",
    requiresSession: true,
    rpc: "checkpoint.restore",
  },
  { id: "worktree.new", title: "New worktree", category: "workspace", rpc: "worktree.create" },
  {
    id: "approval.review",
    title: "Review pending approvals",
    category: "tool",
    keybinding: "ctrl+a",
    rpc: "approval.list",
  },
  { id: "memory.search", title: "Search memory", category: "memory", rpc: "memory.search" },
  {
    id: "memory.review",
    title: "Review proposed memories",
    category: "memory",
    rpc: "memory.list",
  },
  { id: "skill.browse", title: "Browse skills", category: "skill", rpc: "skill.list" },
  {
    id: "skill.proposals",
    title: "Review skill proposals",
    category: "skill",
    rpc: "skill.proposals",
  },
  {
    id: "automation.new",
    title: "New automation",
    category: "automation",
    rpc: "automation.create",
  },
  {
    id: "automation.runNow",
    title: "Run automation now",
    category: "automation",
    rpc: "automation.runNow",
  },
  { id: "plugin.manage", title: "Manage plugins", category: "plugin", rpc: "plugin.list" },
  { id: "view.palette", title: "Command palette", category: "view", keybinding: "ctrl+p" },
  { id: "view.sessions", title: "Go to Sessions", category: "view", keybinding: "ctrl+1" },
  { id: "view.diff", title: "Go to Diff", category: "view", keybinding: "ctrl+2" },
  { id: "view.models", title: "Go to Models", category: "view", keybinding: "ctrl+3" },
  { id: "view.logs", title: "Go to Logs", category: "view", keybinding: "ctrl+4" },
  { id: "view.settings", title: "Go to Settings", category: "view", keybinding: "ctrl+," },
  {
    id: "system.diagnostics",
    title: "Run diagnostics",
    category: "system",
    rpc: "system.diagnostics",
  },
  { id: "system.usage", title: "Usage & cost report", category: "system", rpc: "usage.summary" },
  { id: "system.shutdown", title: "Shutdown daemon", category: "system", rpc: "system.shutdown" },
] as const;

export function searchCommands(query: string): CommandSpec[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...COMMANDS];
  return COMMANDS.filter(
    (c) => c.id.toLowerCase().includes(q) || c.title.toLowerCase().includes(q),
  );
}

export function byKeybinding(key: string): CommandSpec | undefined {
  return COMMANDS.find((c) => c.keybinding === key);
}
