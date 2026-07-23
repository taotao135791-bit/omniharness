import type { Capability, PolicyRule } from "@omniharness/shared-types";
import { globToRegExp } from "./glob.js";

export type PolicyConstraints = NonNullable<PolicyRule["constraints"]>;

/** True when `path` matches at least one of the given globs. */
export function matchPathGlobs(globs: readonly string[], path: string): boolean {
  return globs.some((glob) => globToRegExp(glob).test(path));
}

/**
 * Suffix domain match: "example.com" matches "example.com" and
 * "sub.example.com", but NOT "notexample.com". Case-insensitive.
 */
export function matchDomain(allowed: readonly string[], domain: string): boolean {
  const target = domain.toLowerCase();
  return allowed.some((entry) => {
    const suffix = entry.toLowerCase();
    return target === suffix || target.endsWith(`.${suffix}`);
  });
}

/**
 * Each pattern is treated as a glob matched against the whole command string.
 * Note: `*` does not cross `/`; use `**` for patterns spanning path separators.
 */
export function matchCommandPatterns(patterns: readonly string[], command: string): boolean {
  return patterns.some((pattern) => globToRegExp(pattern).test(command));
}

/**
 * A rule's constraints filter by target: every present dimension
 * (pathGlobs / domains / commandPatterns) must match `target`.
 * `maxFileSizeBytes` is not verifiable at evaluation time — it constrains the
 * granted decision, not the match, so it never filters here.
 *
 * A rule with at least one filtering dimension does NOT match when
 * `target` is undefined.
 */
export function constraintsMatch(
  constraints: PolicyConstraints | undefined,
  capability: Capability,
  target: string | undefined,
): boolean {
  if (constraints === undefined) {
    return true;
  }
  const hasFilter =
    constraints.pathGlobs !== undefined ||
    constraints.domains !== undefined ||
    constraints.commandPatterns !== undefined;
  if (!hasFilter) {
    return true;
  }
  if (target === undefined) {
    return false;
  }
  // The capability parameter documents which dimension is semantically
  // expected for the target; all present dimensions are checked regardless.
  void capability;
  if (constraints.pathGlobs !== undefined && !matchPathGlobs(constraints.pathGlobs, target)) {
    return false;
  }
  if (constraints.domains !== undefined && !matchDomain(constraints.domains, target)) {
    return false;
  }
  if (
    constraints.commandPatterns !== undefined &&
    !matchCommandPatterns(constraints.commandPatterns, target)
  ) {
    return false;
  }
  return true;
}
