/**
 * Minimal argv parser: commands are positional, options are --key value / --key=value / --flag.
 */
export interface ParsedArgs {
  positional: string[];
  options: Record<string, string | boolean>;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  const options: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        options[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          options[arg.slice(2)] = next;
          i++;
        } else {
          options[arg.slice(2)] = true;
        }
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, options };
}

export function optString(opts: Record<string, string | boolean>, key: string): string | undefined {
  const v = opts[key];
  return typeof v === "string" ? v : undefined;
}

export function optBool(opts: Record<string, string | boolean>, key: string): boolean {
  return opts[key] === true || opts[key] === "true";
}
