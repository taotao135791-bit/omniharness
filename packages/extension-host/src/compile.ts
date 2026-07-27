/**
 * Plugin entry compilation for the vm sandbox.
 *
 * Sandboxed plugin entries have no module system: no `require`, no static or
 * dynamic `import` (the sandbox provides no modules at all). To keep plugin
 * authoring ergonomic we support a small, explicit set of module syntaxes and
 * rewrite them before evaluation:
 *
 * - `export function register(api) {...}` / `export async function register`
 * - `export const register = ...`
 * - `export default function (pi) {...}` (Pi-style factory)
 * - `export { register }`
 * - CommonJS: `module.exports.register = ...` / `exports.register = ...`
 *
 * Anything else (notably `import ...`) throws UnsupportedEntryError.
 */

export class UnsupportedEntryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedEntryError";
  }
}

const DEFAULT_BINDING = "__omniDefault__";

function substitute(
  code: string,
  pattern: RegExp,
  replacement: string,
): { code: string; hit: boolean } {
  if (!pattern.test(code)) return { code, hit: false };
  return { code: code.replace(pattern, replacement), hit: true };
}

/**
 * Rewrite a plugin entry's supported module syntax into a plain script that
 * assigns `{ register?, default? }` to `module.exports`. Returns the source
 * unchanged when no ESM syntax is present (CommonJS-style entries assign to
 * `module.exports` themselves).
 */
export function compilePluginEntry(source: string): string {
  if (/^\s*import\s[\w*{]/m.test(source) || /^\s*import\s*["']/m.test(source)) {
    throw new UnsupportedEntryError(
      "Sandboxed plugin entries cannot use `import`; the sandbox provides no modules",
    );
  }

  let code = source;
  let esm = false;
  const sub = (pattern: RegExp, replacement: string): void => {
    const result = substitute(code, pattern, replacement);
    code = result.code;
    esm = esm || result.hit;
  };

  sub(/export\s+default\s+async\s+function/g, `const ${DEFAULT_BINDING} = async function`);
  sub(/export\s+default\s+function/g, `const ${DEFAULT_BINDING} = function`);
  sub(/export\s+default\s+/g, `const ${DEFAULT_BINDING} = `);
  sub(/export\s+(async\s+function|function|const|let|var|class)\s/g, "$1 ");
  sub(/export\s*\{[^}]*\}\s*;?/g, "");

  if (!esm) return code;

  return `${code}
;module.exports = {
  ...(typeof register === "function" ? { register } : {}),
  ...(typeof ${DEFAULT_BINDING} !== "undefined" ? { default: ${DEFAULT_BINDING} } : {}),
};
`;
}
