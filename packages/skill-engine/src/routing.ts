import type { SkillDefinition } from "@omniharness/shared-types";

export interface RoutedSkill {
  skill: SkillDefinition;
  score: number;
  /** Terms from the prompt that matched the skill name/description. */
  matchedTerms: string[];
}

const EXACT_NAME_SCORE = 100;
const NAME_TOKEN_SCORE = 5;
const DESCRIPTION_TOKEN_SCORE = 1;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 2);
}

/**
 * Deterministic keyword routing: which installed skills are relevant to a
 * prompt. Exact name match outranks word overlap; name-token overlap outranks
 * description-token overlap. Disabled skills are never routed. Results are
 * sorted by score (desc), ties broken by name (asc) for stability.
 */
export function routeSkills(prompt: string, installed: SkillDefinition[]): RoutedSkill[] {
  const promptLower = prompt.toLowerCase();
  const promptTokens = new Set(tokenize(prompt));
  const results: RoutedSkill[] = [];

  for (const skill of installed) {
    if (!skill.enabled) continue;
    let score = 0;
    const matched = new Set<string>();

    const nameTokens = tokenize(skill.name);
    const exactMatch =
      promptLower.includes(skill.name.toLowerCase()) ||
      (nameTokens.length > 0 && nameTokens.every((t) => promptTokens.has(t)));
    if (exactMatch) {
      score += EXACT_NAME_SCORE;
      for (const t of nameTokens) matched.add(t);
    }

    for (const token of nameTokens) {
      if (promptTokens.has(token)) {
        score += NAME_TOKEN_SCORE;
        matched.add(token);
      }
    }
    for (const token of tokenize(skill.description)) {
      if (promptTokens.has(token)) {
        score += DESCRIPTION_TOKEN_SCORE;
        matched.add(token);
      }
    }

    if (score > 0) {
      results.push({ skill, score, matchedTerms: [...matched].sort() });
    }
  }

  results.sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name));
  return results;
}
