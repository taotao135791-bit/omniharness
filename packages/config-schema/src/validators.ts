import type {
  Automation,
  ModelCapabilities,
  PluginManifest,
  SkillDefinition,
} from "@omniharness/shared-types";
import { ALL_CAPABILITIES } from "@omniharness/shared-types";

/**
 * Structural validators for the non-settings schemas: model capabilities,
 * plugin manifests, skill definitions, automations. Same idea as field.ts:
 * one validator, used by daemon, TUI, GUI, importers and tests.
 */

export interface SchemaIssue {
  path: string;
  message: string;
}

const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function validateModelCapabilities(input: unknown): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  const c = input as Partial<ModelCapabilities> | null;
  if (typeof c !== "object" || c === null) return [{ path: "", message: "expected object" }];
  for (const key of [
    "text",
    "vision",
    "audioInput",
    "nativeToolCalling",
    "parallelToolCalling",
    "structuredOutput",
    "reasoningControl",
    "promptCaching",
    "supportsSystemMessage",
    "supportsStreaming",
    "supportsComputerUse",
  ] as const) {
    if (!isBool(c[key])) issues.push({ path: key, message: "expected boolean" });
  }
  if (!isNum(c.contextWindow) || (c.contextWindow as number) <= 0)
    issues.push({ path: "contextWindow", message: "expected positive number" });
  if (!isNum(c.maxOutputTokens) || (c.maxOutputTokens as number) <= 0)
    issues.push({ path: "maxOutputTokens", message: "expected positive number" });
  return issues;
}

export function validatePluginManifest(input: unknown): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  const m = input as Partial<PluginManifest> | null;
  if (typeof m !== "object" || m === null) return [{ path: "", message: "expected object" }];
  if (!isStr(m.id)) issues.push({ path: "id", message: "required" });
  if (!isStr(m.name)) issues.push({ path: "name", message: "required" });
  if (!isStr(m.version) || !/^\d+\.\d+\.\d+/.test(m.version ?? ""))
    issues.push({ path: "version", message: "expected semver" });
  if (!isStr(m.entry)) issues.push({ path: "entry", message: "required" });
  if (!isStr(m.license)) issues.push({ path: "license", message: "required" });
  const perms = m.permissions;
  if (typeof perms !== "object" || perms === null) {
    issues.push({ path: "permissions", message: "required" });
  } else {
    const validCaps = new Set<string>(ALL_CAPABILITIES);
    for (const cap of perms.capabilities ?? []) {
      if (!validCaps.has(cap))
        issues.push({ path: `permissions.capabilities`, message: `unknown capability: ${cap}` });
    }
    if (!Array.isArray(perms.tools))
      issues.push({ path: "permissions.tools", message: "expected array" });
    if (!Array.isArray(perms.networkDomains))
      issues.push({ path: "permissions.networkDomains", message: "expected array" });
    if (!Array.isArray(perms.secrets))
      issues.push({ path: "permissions.secrets", message: "expected array" });
  }
  if (!Array.isArray(m.platforms) || m.platforms.length === 0)
    issues.push({ path: "platforms", message: "expected non-empty array" });
  return issues;
}

export function validateSkillDefinition(input: unknown): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  const s = input as Partial<SkillDefinition> | null;
  if (typeof s !== "object" || s === null) return [{ path: "", message: "expected object" }];
  if (!isStr(s.name)) issues.push({ path: "name", message: "required" });
  if (!isStr(s.description)) issues.push({ path: "description", message: "required" });
  if (!isStr(s.body)) issues.push({ path: "body", message: "required" });
  if (!isStr(s.version)) issues.push({ path: "version", message: "required" });
  if (!["global", "profile", "workspace", "project"].includes(String(s.scope)))
    issues.push({ path: "scope", message: "invalid scope" });
  return issues;
}

export function validateAutomation(input: unknown): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  const a = input as Partial<Automation> | null;
  if (typeof a !== "object" || a === null) return [{ path: "", message: "expected object" }];
  if (!isStr(a.name)) issues.push({ path: "name", message: "required" });
  if (!isStr(a.prompt)) issues.push({ path: "prompt", message: "required" });
  const t = a.trigger;
  if (typeof t !== "object" || t === null || !("kind" in t)) {
    issues.push({ path: "trigger", message: "required" });
  } else {
    const kinds = ["once", "cron", "file_change", "git_change", "webhook", "app_launch", "manual"];
    if (!kinds.includes(String(t.kind)))
      issues.push({ path: "trigger.kind", message: "invalid trigger kind" });
    if (t.kind === "cron" && !isStr((t as { expression?: string }).expression))
      issues.push({ path: "trigger.expression", message: "cron trigger requires expression" });
  }
  if (!isNum(a.timeoutMs) || (a.timeoutMs as number) <= 0)
    issues.push({ path: "timeoutMs", message: "expected positive number" });
  return issues;
}
