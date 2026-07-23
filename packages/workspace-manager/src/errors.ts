/** Error thrown when a path violates workspace boundary or path policy. */
export class PathPolicyError extends Error {
  readonly path: string;
  readonly reason:
    | "outside-workspace"
    | "protected"
    | "read-only"
    | "not-found";

  constructor(path: string, reason: PathPolicyError["reason"], message: string) {
    super(message);
    this.name = "PathPolicyError";
    this.path = path;
    this.reason = reason;
  }
}

/** Error thrown for snapshot create/restore failures. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotError";
  }
}
