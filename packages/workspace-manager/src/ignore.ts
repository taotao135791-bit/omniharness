import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface IgnoreRule {
  pattern: string;
  negated: boolean;
  dirOnly: boolean;
  regex: RegExp;
}

/**
 * Translates one gitignore pattern body into a RegExp matched against a
 * workspace-relative POSIX path. Supports `*`, `**`, `?`, character escapes
 * of regex specials, anchoring (`/prefix` or any pattern containing `/`),
 * and basename matching for patterns without a slash.
 */
function patternToRegex(pattern: string, anchored: boolean): RegExp {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // `**` crosses directory boundaries.
        if (pattern[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 3;
        } else {
          out += ".*";
          i += 2;
        }
      } else {
        out += "[^/]*";
        i += 1;
      }
    } else if (ch === "?") {
      out += "[^/]";
      i += 1;
    } else if ("\\.^$+{}()|[]".includes(ch)) {
      out += `\\${ch}`;
      i += 1;
    } else {
      out += ch;
      i += 1;
    }
  }
  return new RegExp(anchored ? `^${out}$` : `^(?:.*/)?${out}$`);
}

/** Parses gitignore-file content into rules (skips comments and blanks). */
export function parseGitignore(content: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const rawLine of content.split("\n")) {
    let line = rawLine;
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line === "" || line.startsWith("#")) continue;

    let negated = false;
    if (line.startsWith("!")) {
      negated = true;
      line = line.slice(1);
    } else if (line.startsWith("\\!") || line.startsWith("\\#")) {
      line = line.slice(1);
    }
    // Trailing spaces are ignored unless escaped (kept simple: trim).
    line = line.trimEnd();
    if (line === "") continue;

    let dirOnly = false;
    if (line.endsWith("/")) {
      dirOnly = true;
      line = line.slice(0, -1);
    }
    const anchored = line.startsWith("/") || line.includes("/");
    if (line.startsWith("/")) {
      line = line.slice(1);
    }
    if (line === "") continue;

    rules.push({ pattern: line, negated, dirOnly, regex: patternToRegex(line, anchored) });
  }
  return rules;
}

/**
 * Gitignore-style matcher over a combined rule set. Later rules win, so
 * negations re-include paths ignored by earlier rules. Directory-only rules
 * also ignore everything beneath the directory.
 */
export class IgnoreMatcher {
  readonly rules: readonly IgnoreRule[];

  constructor(rules: readonly IgnoreRule[]) {
    this.rules = rules;
  }

  static fromContent(...contents: string[]): IgnoreMatcher {
    return new IgnoreMatcher(contents.flatMap((c) => parseGitignore(c)));
  }

  /**
   * Reads `.gitignore` then `.omniharnessignore` from `root` (missing files
   * are fine). `.omniharnessignore` rules come last and therefore win.
   */
  static async fromRoot(root: string): Promise<IgnoreMatcher> {
    const read = async (name: string): Promise<string> => {
      try {
        return await readFile(join(root, name), "utf8");
      } catch {
        return "";
      }
    };
    return IgnoreMatcher.fromContent(
      await read(".gitignore"),
      await read(".omniharnessignore"),
    );
  }

  /** Tests a workspace-relative POSIX path. */
  isIgnored(relPath: string, isDir: boolean): boolean {
    const segments = relPath.split("/").filter((s) => s !== "" && s !== ".");
    if (segments.length === 0) return false;
    const rel = segments.join("/");

    let ignored = false;
    for (const rule of this.rules) {
      if (rule.regex.test(rel) && (!rule.dirOnly || isDir)) {
        ignored = !rule.negated;
      }
    }
    if (ignored) return true;

    // A path is ignored when any ancestor directory is ignored.
    for (let i = 1; i < segments.length; i++) {
      const ancestor = segments.slice(0, i).join("/");
      let ancestorIgnored = false;
      for (const rule of this.rules) {
        if (rule.regex.test(ancestor)) {
          ancestorIgnored = !rule.negated;
        }
      }
      if (ancestorIgnored) return true;
    }
    return false;
  }
}

/** Convenience single-pattern test with gitignore semantics. */
export function matchesPattern(pattern: string, relPath: string, isDir: boolean): boolean {
  const matcher = new IgnoreMatcher(parseGitignore(pattern));
  return matcher.isIgnored(relPath, isDir);
}
