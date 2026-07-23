import type {
  AgentId,
  AgentRunId,
  AutomationId,
  ChannelId,
  EventSeq,
  IsoTimestamp,
  MessageId,
  ModelId,
  NodeId,
  ProfileId,
  ProjectId,
  SessionId,
  ToolCallId,
} from "@omniharness/shared-types";
import type {
  Capability,
  PolicyRule,
  PolicyScope,
  TokenUsage,
} from "@omniharness/shared-types";

/** A single recorded tool invocation (no shared-types counterpart yet). */
export type ToolCallStatus = "pending" | "running" | "completed" | "failed" | "denied";

export interface ToolCallRecord {
  id: ToolCallId;
  sessionId: SessionId;
  agentRunId: AgentRunId | null;
  /** Message that contains the tool_call part, once known. */
  messageId: MessageId | null;
  name: string;
  /** JSON-encoded arguments as produced by the model. */
  argumentsJson: string;
  status: ToolCallStatus;
  /** JSON-encoded tool result, NULL until completed. */
  resultJson: string | null;
  error: string | null;
  /** Capability the policy engine classified this call under, if evaluated. */
  capability: Capability | null;
  startedAt: IsoTimestamp;
  endedAt: IsoTimestamp | null;
}

/** One billable usage sample, written whenever a run reports TokenUsage. */
export interface ModelUsageRecord {
  id: number;
  at: IsoTimestamp;
  modelId: ModelId;
  profileId: ProfileId | null;
  projectId: ProjectId | null;
  sessionId: SessionId | null;
  agentId: AgentId | null;
  automationId: AutomationId | null;
  usage: TokenUsage;
}

/** Attribution dimensions available for usage aggregation. */
export type UsageDimension = "model" | "project" | "agent" | "automation";

export interface UsageAggregateRow {
  /** Dimension value (ModelId/ProjectId/AgentId/AutomationId as plain string; null = unattributed). */
  key: string | null;
  usage: TokenUsage;
  samples: number;
}

/** A persisted permission rule at a specific policy scope. */
export interface PermissionRuleRecord {
  id: number;
  scope: PolicyScope;
  rule: PolicyRule;
  createdAt: IsoTimestamp;
}

/** Immutable audit-trail entry. */
export interface AuditEventRecord {
  id: number;
  at: IsoTimestamp;
  /** Who acted: "user", "agent:<id>", "automation:<id>", "system". */
  actor: string;
  /** What happened, e.g. "approval.granted", "session.archived". */
  action: string;
  detail: Record<string, string>;
  sessionId: SessionId | null;
}

/** Settings are keyed by (scope, scopeId, key); scopeId is "" for "global". */
export type SettingsScope = "global" | "profile" | "project" | "workspace" | "session";

export interface SettingEntry {
  scope: SettingsScope;
  scopeId: string;
  key: string;
  value: unknown;
}

/** An external messaging/notification channel binding. */
export interface ChannelRecord {
  id: ChannelId;
  kind: string;
  displayName: string;
  config: Record<string, unknown>;
  enabled: boolean;
  createdAt: IsoTimestamp;
}

/** A paired device / remote execution node. */
export type NodeStatus = "online" | "offline" | "degraded";

export interface NodeRecord {
  id: NodeId;
  name: string;
  address: string;
  status: NodeStatus;
  capabilities: string[];
  lastSeenAt: IsoTimestamp | null;
  createdAt: IsoTimestamp;
}

/** A stored event-log entry. `seq` is the daemon-wide total ordering. */
export interface StoredEvent {
  seq: EventSeq;
  at: IsoTimestamp;
  type: string;
  payload: unknown;
}

/** Generic offset pagination envelope. */
export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface Pagination {
  limit?: number;
  offset?: number;
}
