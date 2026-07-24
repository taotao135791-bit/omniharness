/**
 * Minimal glob matcher for file-watch triggers: `**` crosses path separators,
 * `*` matches within a segment, `?` matches a single non-separator char.
 * Paths are matched verbatim (leading `/` included); no brace expansion.
 */

function escapeRe(c: string): string {
  return /[.*+?^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
}

export function globToRegExp(glob: string): RegExp {
  let re = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob.charAt(i);
    if (c === "*") {
      if (glob.charAt(i + 1) === "*") {
        if (glob.charAt(i + 2) === "/") {
          // "**/" matches zero or more whole segments.
          re += "(?:[^/]+/)*";
          i += 3;
        } else {
          re += ".*";
          i += 2;
        }
      } else {
        re += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      re += "[^/]";
      i += 1;
    } else {
      re += escapeRe(c);
      i += 1;
    }
  }
  return new RegExp(`^${re}$`);
}

export function matchGlob(glob: string, path: string): boolean {
  return globToRegExp(glob).test(path);
}

/**
 * The non-wildcard directory prefix of a glob — the deepest directory that can
 * be watched without missing any match. Falls back to "." for fully-relative
 * wildcard globs.
 */
export function staticBaseDir(glob: string): string {
  const segments = glob.split("/");
  const staticSegs: string[] = [];
  for (const seg of segments) {
    if (/[*?[]/.test(seg)) break;
    staticSegs.push(seg);
  }
  const joined = staticSegs.join("/");
  if (joined === "") return glob.startsWith("/") ? "/" : ".";
  return joined;
}
