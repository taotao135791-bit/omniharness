/** Error thrown when a git CLI invocation fails. */
export class GitError extends Error {
  readonly gitArgs: readonly string[];
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
  readonly cwd: string;

  constructor(
    gitArgs: readonly string[],
    exitCode: number,
    stderr: string,
    stdout: string,
    cwd: string,
  ) {
    const detail = stderr.trim() || stdout.trim() || "unknown error";
    super(`git ${gitArgs.join(" ")} failed (exit ${exitCode}): ${detail}`);
    this.name = "GitError";
    this.gitArgs = gitArgs;
    this.exitCode = exitCode;
    this.stderr = stderr;
    this.stdout = stdout;
    this.cwd = cwd;
  }
}

/** True when the error is git reporting that the path is not inside a repository. */
export function isNotARepoError(error: unknown): boolean {
  return error instanceof GitError && /not a git repository/i.test(error.stderr);
}
