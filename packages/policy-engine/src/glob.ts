/**
 * Minimal glob implementation supporting:
 * - `**`  matches any number of path segments (including none when written as `**\/`)
 * - `*`   matches any run of characters within a single path segment (no `/`)
 * - `?`   matches a single character within a path segment (no `/`)
 *
 * All other characters are matched literally (regex metacharacters escaped).
 * The resulting RegExp is anchored for full-string matches.
 */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  let i = 0;
  while (i < glob.length) {
    const ch = glob.charAt(i);
    if (ch === "*") {
      if (glob.charAt(i + 1) === "*") {
        if (glob.charAt(i + 2) === "/") {
          // `**/` also matches zero segments, so `a/**\/b` matches `a/b`.
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
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/, "\\$&");
      i += 1;
    }
  }
  return new RegExp(`^${out}$`);
}
