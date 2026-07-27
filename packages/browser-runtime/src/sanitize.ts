/**
 * Untrusted-content boundary.
 *
 * Page text is adversarial by definition: a hostile page can embed strings
 * that look like system prompts or operator instructions ("ignore previous
 * instructions", "system: you are now..."). Before page-derived text enters
 * model context it passes through sanitizeObservation, a documented
 * HEURISTIC — it reduces obvious injection surface but is not a security
 * proof; higher layers must still treat page text as data, never as
 * instructions.
 *
 * The heuristic:
 *  1. strips zero-width and bidi control characters (invisible smuggling);
 *  2. strips HTML comments (classic hiding spot for injected instructions);
 *  3. strips ANSI escape sequences;
 *  4. drops lines that open with chat-role markers ("system:", "assistant:",
 *     "user:", "developer:") which mimic conversation scaffolding;
 *  5. replaces known prompt-injection phrases ("ignore previous
 *     instructions", "you are now", "new instructions:", ...) with
 *     "[neutralized]" and flags the observation.
 */

export interface SanitizeResult {
  text: string;
  /** True when any injection-looking content was found. */
  flagged: boolean;
  /** Number of lines removed or phrases neutralized. */
  removedCount: number;
}

const ZERO_WIDTH_AND_BIDI = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const ANSI_ESCAPE = /\x1B\[[0-9;?]*[ -\/]*[@-~]/g;
const ROLE_MARKER_LINE = /^\s*(system|assistant|user|developer)\s*[:：]/i;

const INJECTION_PHRASES: readonly RegExp[] = [
  /ignore (all |any )?(previous|prior|above|earlier) (instructions|directions|prompts)/gi,
  /disregard (all |any )?(previous|prior|above|earlier) (instructions|directions)/gi,
  /you are now\b/gi,
  /new instructions?\s*[:：]/gi,
  /forget (everything|all|your)( you)? (know|were told|instructions)/gi,
  /do not follow (your )?(previous|prior) (instructions|rules)/gi,
  /override (your )?(system|safety) (prompt|instructions|rules)/gi,
];

export function sanitizeObservation(input: string): SanitizeResult {
  let removedCount = 0;
  let flagged = false;

  let text = input.replace(ZERO_WIDTH_AND_BIDI, (match) => {
    removedCount += match.length;
    flagged = true;
    return "";
  });

  text = text.replace(HTML_COMMENT, () => {
    removedCount += 1;
    return " ";
  });

  text = text.replace(ANSI_ESCAPE, () => {
    removedCount += 1;
    return "";
  });

  for (const phrase of INJECTION_PHRASES) {
    text = text.replace(phrase, () => {
      removedCount += 1;
      flagged = true;
      return "[neutralized]";
    });
  }

  const keptLines: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (ROLE_MARKER_LINE.test(line)) {
      removedCount += 1;
      flagged = true;
      continue;
    }
    keptLines.push(line);
  }

  return { text: keptLines.join("\n"), flagged, removedCount };
}
