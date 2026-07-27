import type { ComputerAction } from "./types.js";

export type SensitiveKind =
  | "password_field"
  | "credential_entry"
  | "message_send"
  | "purchase"
  | "deletion"
  | "file_selection";

export interface SensitiveAssessment {
  sensitive: boolean;
  kinds: SensitiveKind[];
  reasons: string[];
}

interface PatternRule {
  kind: SensitiveKind;
  pattern: RegExp;
  reason: string;
}

/**
 * Heuristic pattern rules, evaluated against the action's free-text fields
 * (hint, typed text, app name, file paths). The proposer-supplied `hint`
 * ("type into the password field") is the primary signal; typed text is a
 * secondary one (a URL or "confirm payment" typed by the model).
 */
const PATTERN_RULES: readonly PatternRule[] = [
  {
    kind: "password_field",
    pattern: /password|passwd|passcode|\bpin\b|\bcvv\b|\bcvc\b|card\s*number|secret\s*key/i,
    reason: "targets or mentions a password / credential field",
  },
  {
    kind: "message_send",
    pattern: /\bsend\b|\bmessage\b|\breply\b|\bemail\b|\bpost\b|\bpublish\b|\bcomment\b|\btweet\b|\bshare\b/i,
    reason: "may send or publish a message visible to others",
  },
  {
    kind: "purchase",
    pattern: /purchase|\bbuy\b|checkout|\bpay\b|payment|\border\b|subscribe|billing|place\s+order/i,
    reason: "may complete a purchase or payment",
  },
  {
    kind: "deletion",
    pattern: /\bdelete\b|\bremove\b|\btrash\b|\berase\b|\bformat\b|\bwipe\b|\bdestroy\b/i,
    reason: "may delete or destroy data",
  },
];

function searchableText(action: ComputerAction): string {
  const parts: string[] = [];
  if ("hint" in action && action.hint !== undefined) {
    parts.push(action.hint);
  }
  switch (action.kind) {
    case "type":
      parts.push(action.text);
      break;
    case "launch_app":
      parts.push(action.app);
      break;
    case "switch_window":
      parts.push(action.target);
      break;
    case "choose_file":
      parts.push(...action.paths);
      break;
    case "secure_fill":
      parts.push(action.secretRef);
      break;
    default:
      break;
  }
  return parts.join("\n");
}

/**
 * Classifies an action for the sensitive-action gate. Purely structural
 * kinds are decided first (secure_fill always counts as credential entry;
 * choose_file always counts as file selection — it hands local files to a
 * remote context), then heuristic text rules run for actions that can touch
 * passwords, send messages, make purchases, or delete data.
 */
export function classifyAction(action: ComputerAction): SensitiveAssessment {
  const kinds = new Set<SensitiveKind>();
  const reasons: string[] = [];

  if (action.kind === "secure_fill") {
    kinds.add("credential_entry");
    reasons.push("types a resolved secret into the active field");
  }
  if (action.kind === "choose_file") {
    kinds.add("file_selection");
    reasons.push(`selects local files: ${action.paths.join(", ")}`);
  }

  const text = searchableText(action);
  for (const rule of PATTERN_RULES) {
    if (!kinds.has(rule.kind) && rule.pattern.test(text)) {
      kinds.add(rule.kind);
      reasons.push(rule.reason);
    }
  }

  const ordered = [...kinds];
  return { sensitive: ordered.length > 0, kinds: ordered, reasons };
}
