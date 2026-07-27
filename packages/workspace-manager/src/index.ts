export { PathPolicyError, SnapshotError } from "./errors.js";
export { IgnoreMatcher, parseGitignore, matchesPattern } from "./ignore.js";
export type { IgnoreRule } from "./ignore.js";
export { assertReadable, assertWritable, realpathLoose, resolveInWorkspace } from "./paths.js";
export type { ResolvedPath } from "./paths.js";
export { WorkspaceManager, detectKind } from "./manager.js";
export type { RegisterWorkspaceInput } from "./manager.js";
export {
  createSnapshot,
  restoreSnapshot,
  walkWorkspaceFiles,
  DEFAULT_MAX_FILE_SIZE_BYTES,
} from "./snapshots.js";
export type { SnapshotInfo, SnapshotOptions } from "./snapshots.js";
