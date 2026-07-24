import { randomUUID } from "node:crypto";
import type { SchemaIssue } from "@omniharness/config-schema";
import { validateAutomation } from "@omniharness/config-schema";
import type { AutomationsRepo } from "@omniharness/session-store";
import type {
  Automation,
  AutomationId,
  AutomationRun,
  AutomationRunStatus,
  IsoTimestamp,
  ProfileId,
} from "@omniharness/shared-types";
import { nextRun, resolveTimezoneOffsetMinutes, CronParseError } from "./cron.js";

export function newAutomationId(): AutomationId {
  return `auto_${randomUUID()}` as AutomationId;
}

export class AutomationValidationError extends Error {
  readonly issues: readonly SchemaIssue[];
  constructor(issues: readonly SchemaIssue[]) {
    super(`invalid automation: ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`);
    this.name = "AutomationValidationError";
    this.issues = issues;
  }
}

export class AutomationNotFoundError extends Error {
  constructor(id: AutomationId) {
    super(`automation not found: ${id}`);
    this.name = "AutomationNotFoundError";
  }
}

/**
 * The profile-level policy an automation is constrained by. Returning null
 * from allowedTools means the profile imposes no tool restriction. The daemon
 * implements this from the real policy engine; automations can never widen it.
 */
export interface ProfilePolicy {
  allowedTools(profileId: ProfileId): readonly string[] | null;
  networkAllowed(profileId: ProfileId): boolean;
}

/** Default policy: no profile-level restrictions (automation list decides). */
export const UNRESTRICTED_POLICY: ProfilePolicy = {
  allowedTools: () => null,
  networkAllowed: () => true,
};

/** What an automation may actually use — never broader than either source. */
export interface EffectivePermissions {
  tools: string[];
  networkAllowed: boolean;
}

export type CreateAutomationInput = Omit<
  Automation,
  "id" | "createdAt" | "updatedAt" | "lastRunAt" | "nextRunAt"
> & { id?: AutomationId };

export type UpdateAutomationPatch = Partial<
  Omit<Automation, "id" | "createdAt" | "updatedAt" | "lastRunAt" | "nextRunAt">
>;

export interface AutomationEngineDeps {
  repo: AutomationsRepo;
  policy?: ProfilePolicy;
  now?: () => Date;
}

/**
 * CRUD for automations on top of the session-store automations repo.
 * Validates via config-schema (plus cron/file-glob checks) and maintains
 * `nextRunAt` on every mutation.
 */
export class AutomationEngine {
  private readonly repo: AutomationsRepo;
  private readonly policy: ProfilePolicy;
  private readonly now: () => Date;

  constructor(deps: AutomationEngineDeps) {
    this.repo = deps.repo;
    this.policy = deps.policy ?? UNRESTRICTED_POLICY;
    this.now = deps.now ?? (() => new Date());
  }

  create(input: CreateAutomationInput): Automation {
    const nowIso = this.now().toISOString();
    const automation: Automation = {
      ...input,
      id: input.id ?? newAutomationId(),
      createdAt: nowIso,
      updatedAt: nowIso,
      lastRunAt: null,
      nextRunAt: null,
    };
    this.validate(automation);
    automation.nextRunAt = automation.enabled
      ? this.computeNextRunAt(automation, this.now())
      : null;
    this.repo.put(automation);
    return automation;
  }

  update(id: AutomationId, patch: UpdateAutomationPatch): Automation {
    const existing = this.repo.get(id);
    if (existing === undefined) throw new AutomationNotFoundError(id);
    const merged: Automation = {
      ...existing,
      ...patch,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: this.now().toISOString(),
    };
    this.validate(merged);
    merged.nextRunAt = merged.enabled ? this.computeNextRunAt(merged, this.now()) : null;
    this.repo.put(merged);
    return merged;
  }

  get(id: AutomationId): Automation | undefined {
    return this.repo.get(id);
  }

  list(enabledOnly = false): Automation[] {
    return this.repo.list(enabledOnly);
  }

  /** Pause (enabled=false clears nextRunAt) or resume (recomputes it). */
  setEnabled(id: AutomationId, enabled: boolean): Automation {
    const existing = this.repo.get(id);
    if (existing === undefined) throw new AutomationNotFoundError(id);
    const updated: Automation = {
      ...existing,
      enabled,
      updatedAt: this.now().toISOString(),
      nextRunAt: enabled ? this.computeNextRunAt(existing, this.now()) : null,
    };
    this.repo.put(updated);
    return updated;
  }

  delete(id: AutomationId): boolean {
    return this.repo.delete(id);
  }

  listRuns(automationId: AutomationId, status?: AutomationRunStatus): AutomationRun[] {
    return this.repo.listRuns(automationId, status);
  }

  /** Next fire time for the trigger, or null for event-driven/expired ones. */
  computeNextRunAt(automation: Automation, after: Date): IsoTimestamp | null {
    const trigger = automation.trigger;
    switch (trigger.kind) {
      case "once": {
        const afterIso = after.toISOString();
        return trigger.at > afterIso ? trigger.at : null;
      }
      case "cron": {
        const offset = resolveTimezoneOffsetMinutes(trigger.timezone, after);
        const next = nextRun(trigger.expression, after, offset);
        return next === null ? null : next.toISOString();
      }
      default:
        // file_change, git_change, webhook, app_launch, manual: event-driven.
        return null;
    }
  }

  /**
   * Guard: the permissions an automation run actually gets — the intersection
   * of the automation's own allowedTools with the profile policy. An
   * automation can never widen what its profile allows.
   */
  effectivePermissions(automation: Automation): EffectivePermissions {
    const policyTools = this.policy.allowedTools(automation.profileId);
    const tools =
      policyTools === null
        ? [...automation.allowedTools]
        : automation.allowedTools.filter((t) => policyTools.includes(t));
    return {
      tools,
      networkAllowed: automation.networkAllowed && this.policy.networkAllowed(automation.profileId),
    };
  }

  // ---- scheduler-facing facade over the repo ----

  listDue(at: IsoTimestamp): Automation[] {
    return this.repo.listDue(at);
  }

  markRun(id: AutomationId, lastRunAt: IsoTimestamp, nextRunAt: IsoTimestamp | null): void {
    this.repo.markRun(id, lastRunAt, nextRunAt);
  }

  recordRun(run: AutomationRun): void {
    this.repo.putRun(run);
  }

  private validate(automation: Automation): void {
    const issues: SchemaIssue[] = [...validateAutomation(automation)];
    if (automation.trigger.kind === "cron") {
      try {
        nextRun(automation.trigger.expression, this.now());
      } catch (err) {
        if (err instanceof CronParseError) {
          issues.push({ path: "trigger.expression", message: err.message });
        } else {
          throw err;
        }
      }
    }
    if (automation.trigger.kind === "file_change" && automation.trigger.pathGlob.trim() === "") {
      issues.push({ path: "trigger.pathGlob", message: "required" });
    }
    if (issues.length > 0) throw new AutomationValidationError(issues);
  }
}
