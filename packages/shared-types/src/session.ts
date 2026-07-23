import type {
  AgentId,
  AgentRunId,
  IsoTimestamp,
  MessageId,
  ModelId,
  ProfileId,
  ProjectId,
  SessionId,
  ToolCallId,
  WorkspaceId,
} from "./ids.js";
import type { TokenUsage } from "./model.js";

export type MessageRole = "user" | "assistant" | "system" | "tool";

export interface AttachmentRef {
  kind: "image" | "file" | "audio" | "video";
  /** Absolute path or artifact:// URI. */
  uri: string;
  mimeType: string;
  sizeBytes: number;
  name: string;
}

export interface MessagePart {
  type: "text" | "reasoning" | "tool_call" | "tool_result" | "attachment" | "error";
  text?: string;
  toolCallId?: ToolCallId;
  toolName?: string;
  argumentsJson?: string;
  resultJson?: string;
  isError?: boolean;
  attachment?: AttachmentRef;
}

export interface Message {
  id: MessageId;
  sessionId: SessionId;
  /** Parent message for branching; null for the root. */
  parentId: MessageId | null;
  role: MessageRole;
  parts: MessagePart[];
  createdAt: IsoTimestamp;
  modelId?: ModelId;
  usage?: TokenUsage;
}

export type SessionStatus = "active" | "archived" | "deleted";

export interface Session {
  id: SessionId;
  profileId: ProfileId;
  projectId: ProjectId;
  workspaceId: WorkspaceId;
  title: string;
  tags: string[];
  status: SessionStatus;
  /** Active branch tip. */
  headMessageId: MessageId | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  /** Pinned model override for this session. */
  modelId?: ModelId;
  /** Total usage across all runs. */
  totalUsage: TokenUsage;
}

export type AgentRunStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export type AgentKind = "primary" | "subagent" | "planner" | "executor" | "reviewer" | "critic";

export interface Agent {
  id: AgentId;
  sessionId: SessionId;
  kind: AgentKind;
  parentAgentId: AgentId | null;
  displayName: string;
  status: AgentRunStatus;
  allowedTools: string[] | null; // null = inherit
  modelId?: ModelId;
  createdAt: IsoTimestamp;
}

export interface AgentRun {
  id: AgentRunId;
  agentId: AgentId;
  sessionId: SessionId;
  status: AgentRunStatus;
  startedAt: IsoTimestamp;
  endedAt: IsoTimestamp | null;
  usage: TokenUsage;
  error?: string;
  /** For crash recovery: last durable event seq emitted by this run. */
  lastEventSeq: number;
}
