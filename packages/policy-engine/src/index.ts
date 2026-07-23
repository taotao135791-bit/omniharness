export { PolicyEngine } from "./engine.js";
export type {
  PolicyEngineOptions,
  RuleScopeKind,
  ScopedRuleScopeKind,
  StoredPolicyRule,
} from "./engine.js";

export { globToRegExp } from "./glob.js";

export {
  constraintsMatch,
  matchCommandPatterns,
  matchDomain,
  matchPathGlobs,
} from "./match.js";
export type { PolicyConstraints } from "./match.js";

export { classifyRisk, DANGEROUS_COMMAND_PATTERNS } from "./risk.js";

export { isInsideWorkspace, productDefault } from "./defaults.js";
export type { BuiltinDefaultsOptions, ProductDefaultResult } from "./defaults.js";

export {
  deserializeRules,
  ruleFromRow,
  ruleToRow,
  serializeRules,
} from "./serialize.js";
export type { PolicyRuleRow } from "./serialize.js";
