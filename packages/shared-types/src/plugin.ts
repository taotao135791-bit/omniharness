import type { IsoTimestamp, PluginId, SkillId } from "./ids.js";
import type { Capability } from "./policy.js";

/** A Skill: procedural knowledge loaded on demand. Not executable code by itself. */
export interface SkillDefinition {
  id: SkillId;
  name: string;
  description: string;
  version: string;
  /** Markdown body with instructions. */
  body: string;
  /** Relative resource paths bundled with the skill. */
  resources: string[];
  /** Capabilities this skill needs when its scripts run. */
  requiredCapabilities: Capability[];
  scope: "global" | "profile" | "workspace" | "project";
  enabled: boolean;
  /** Skills this one depends on (by name@version range). */
  dependencies: string[];
  source: "bundled" | "registry" | "local" | "learned" | "imported";
  sourcePath?: string;
  createdAt: IsoTimestamp;
}

export type SkillProposalStatus = "pending" | "testing" | "approved" | "rejected";

/** A learned-skill proposal pending human approval. */
export interface SkillProposal {
  id: string;
  skill: SkillDefinition;
  /** What changed vs. the existing skill version (unified diff), if an update. */
  diff: string | null;
  basedOnSessionId: string;
  status: SkillProposalStatus;
  testResult?: { passed: boolean; output: string };
  createdAt: IsoTimestamp;
}

/** Permissions a plugin declares in its manifest. */
export interface PluginPermissions {
  capabilities: Capability[];
  /** Tools the plugin registers. */
  tools: string[];
  /** UI extension points the plugin uses. */
  uiExtensions: string[];
  /** Whether the plugin registers model providers. */
  registersProviders: boolean;
  /** Secret names the plugin may read from the secret store. */
  secrets: string[];
  /** Domains the plugin may contact. */
  networkDomains: string[];
}

export interface PluginManifest {
  id: PluginId;
  name: string;
  version: string;
  description: string;
  author: string;
  license: string;
  entry: string;
  permissions: PluginPermissions;
  platforms: Array<"macos" | "windows" | "linux">;
  /** SHA-256 of the plugin bundle for integrity checks. */
  integrityHash?: string;
  signature?: string;
}

export type PluginTrustLevel = "bundled" | "signed" | "unsigned";

export interface InstalledPlugin {
  manifest: PluginManifest;
  trust: PluginTrustLevel;
  enabled: boolean;
  installedAt: IsoTimestamp;
  /** Permissions granted at install time; upgrades that expand this require re-review. */
  grantedPermissions: PluginPermissions;
}
