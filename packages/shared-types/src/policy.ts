import type { ApprovalId, IsoTimestamp, ToolCallId } from "./ids.js";

/** Capability dimensions the policy engine reasons over. */
export type Capability =
  | "fs.read"
  | "fs.write"
  | "fs.outsideWorkspace"
  | "shell.exec"
  | "network"
  | "browser"
  | "computerUse"
  | "secret.read"
  | "clipboard"
  | "camera"
  | "microphone"
  | "notification"
  | "message.send"
  | "git.push"
  | "software.install"
  | "system.settings"
  | "fs.delete"
  | "payment";

export const ALL_CAPABILITIES: readonly Capability[] = [
  "fs.read",
  "fs.write",
  "fs.outsideWorkspace",
  "shell.exec",
  "network",
  "browser",
  "computerUse",
  "secret.read",
  "clipboard",
  "camera",
  "microphone",
  "notification",
  "message.send",
  "git.push",
  "software.install",
  "system.settings",
  "fs.delete",
  "payment",
] as const;

export type RiskLevel = "low" | "medium" | "high" | "critical";

export type PolicyDecisionKind =
  | "deny"
  | "ask_every_time"
  | "ask_once_per_session"
  | "allow_for_workspace"
  | "allow_with_constraints"
  | "always_allow";

export interface PolicyRule {
  capability: Capability;
  decision: PolicyDecisionKind;
  /** Optional constraints, e.g. allowed domains, path globs, command patterns. */
  constraints?: {
    pathGlobs?: string[];
    domains?: string[];
    commandPatterns?: string[];
    maxFileSizeBytes?: number;
  };
}

/** Policy scopes, evaluated from most specific to least. */
export type PolicyScope =
  | { kind: "one_time"; approvalId: ApprovalId }
  | { kind: "automation"; automationId: string }
  | { kind: "tool"; toolName: string }
  | { kind: "agent"; agentId: string }
  | { kind: "project"; projectId: string }
  | { kind: "workspace"; workspaceId: string }
  | { kind: "profile"; profileId: string }
  | { kind: "product_default" };

export interface PolicyEvaluationContext {
  capability: Capability;
  toolName: string;
  agentId?: string;
  sessionId?: string;
  projectId?: string;
  workspaceId?: string;
  profileId?: string;
  automationId?: string;
  /** Concrete target being accessed, e.g. a path, domain, or command line. */
  target?: string;
}

export interface PolicyEvaluation {
  decision: PolicyDecisionKind;
  risk: RiskLevel;
  matchedScope: PolicyScope["kind"];
  reason: string;
  constraints?: PolicyRule["constraints"];
}

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired" | "cancelled";

export interface ApprovalRequest {
  id: ApprovalId;
  toolCallId: ToolCallId;
  capability: Capability;
  risk: RiskLevel;
  /** Human-readable description of what will happen. */
  summary: string;
  /** Machine-readable detail (path, command, domain...). */
  detail: Record<string, string>;
  status: ApprovalStatus;
  createdAt: IsoTimestamp;
  resolvedAt: IsoTimestamp | null;
  resolvedBy: "user" | "rule" | "timeout" | null;
  /** If approved: what scope the approval grants. */
  grantedScope?: PolicyDecisionKind;
  expiresAt: IsoTimestamp;
}
