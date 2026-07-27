import type {
  AutomationId,
  AutomationRunId,
  IsoTimestamp,
  ProfileId,
  SessionId,
  WorkspaceId,
} from "./ids.js";
import type { TaskBudget } from "./task.js";

export type AutomationTrigger =
  | { kind: "once"; at: IsoTimestamp }
  | { kind: "cron"; expression: string; timezone?: string }
  | { kind: "file_change"; pathGlob: string; debounceMs?: number }
  | { kind: "git_change"; ref?: string }
  | { kind: "webhook"; endpointId: string }
  | { kind: "app_launch" }
  | { kind: "manual" };

export type AutomationRunStatus =
  "queued" | "running" | "completed" | "failed" | "skipped" | "cancelled";

export interface Automation {
  id: AutomationId;
  name: string;
  description: string;
  enabled: boolean;
  trigger: AutomationTrigger;
  profileId: ProfileId;
  workspaceId: WorkspaceId;
  /** Instruction prompt executed in a fresh isolated session. */
  prompt: string;
  skills: string[];
  /** Automations never get broader permissions than this list. */
  allowedTools: string[];
  networkAllowed: boolean;
  budget: TaskBudget;
  timeoutMs: number;
  /** Where results go: notification, file, channel. */
  output: { kind: "notification" | "file" | "channel"; target?: string };
  onFailure: "notify" | "retry" | "ignore";
  maxRetries: number;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  lastRunAt: IsoTimestamp | null;
  nextRunAt: IsoTimestamp | null;
}

export interface AutomationRun {
  id: AutomationRunId;
  automationId: AutomationId;
  status: AutomationRunStatus;
  sessionId: SessionId | null;
  startedAt: IsoTimestamp;
  endedAt: IsoTimestamp | null;
  resultSummary?: string;
  error?: string;
  attempt: number;
}
