/**
 * Convenience re-exports so commands.ts and implementors import domain types
 * from one place. Single source of truth remains @omniharness/shared-types.
 */
export type {
  Agent,
  AgentRun,
  AgentTask,
  ApprovalRequest,
  Artifact,
  Automation,
  AutomationRun,
  Checkpoint,
  InstalledPlugin,
  MemoryEntry,
  MemorySearchResult,
  Message,
  ModelDefinition,
  ModelRole,
  Profile,
  Project,
  ProviderConfig,
  ProviderKind,
  Session,
  SessionId,
  SkillDefinition,
  SkillProposal,
  TaskId,
  TokenUsage,
  Workspace,
  Worktree,
} from "@omniharness/shared-types";

/** A user's answer to an approval request. */
export type ApprovalDecision = "approve" | "deny";
