/**
 * Branded ID types. All IDs are nanoid-style strings, prefixed per entity so a
 * bare ID is self-describing in logs and the database.
 */
export type ProfileId = string & { readonly __brand: "ProfileId" };
export type ProjectId = string & { readonly __brand: "ProjectId" };
export type WorkspaceId = string & { readonly __brand: "WorkspaceId" };
export type SessionId = string & { readonly __brand: "SessionId" };
export type MessageId = string & { readonly __brand: "MessageId" };
export type AgentRunId = string & { readonly __brand: "AgentRunId" };
export type AgentId = string & { readonly __brand: "AgentId" };
export type TaskId = string & { readonly __brand: "TaskId" };
export type ToolCallId = string & { readonly __brand: "ToolCallId" };
export type ApprovalId = string & { readonly __brand: "ApprovalId" };
export type CheckpointId = string & { readonly __brand: "CheckpointId" };
export type ArtifactId = string & { readonly __brand: "ArtifactId" };
export type ProviderId = string & { readonly __brand: "ProviderId" };
export type ModelId = string & { readonly __brand: "ModelId" };
export type SkillId = string & { readonly __brand: "SkillId" };
export type MemoryId = string & { readonly __brand: "MemoryId" };
export type AutomationId = string & { readonly __brand: "AutomationId" };
export type AutomationRunId = string & { readonly __brand: "AutomationRunId" };
export type PluginId = string & { readonly __brand: "PluginId" };
export type ChannelId = string & { readonly __brand: "ChannelId" };
export type NodeId = string & { readonly __brand: "NodeId" };
export type WorktreeId = string & { readonly __brand: "WorktreeId" };
export type EventSeq = number & { readonly __brand: "EventSeq" };

/** ISO-8601 timestamp string. */
export type IsoTimestamp = string;

export function nowIso(): IsoTimestamp {
  return new Date().toISOString();
}
