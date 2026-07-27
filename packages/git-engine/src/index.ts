export { GitError, isNotARepoError } from "./errors.js";
export { gitRaw, git } from "./exec.js";
export type { GitExecOptions, GitRawResult } from "./exec.js";
export { isRepo, init, status, currentBranch, createBranch } from "./repo.js";
export type { GitStatus } from "./repo.js";
export { diff, parseUnifiedDiff, applyHunks } from "./diff.js";
export type { DiffFile, DiffFileStatus, DiffHunk, DiffOptions, ApplyHunksOptions } from "./diff.js";
export { worktreeAdd, worktreeRemove, worktreeList } from "./worktree.js";
export type { WorktreeInfo, WorktreeAddOptions } from "./worktree.js";
export {
  checkpointCommit,
  restoreCheckpoint,
  stash,
  stashPop,
  revertCommit,
} from "./checkpoint.js";
export type { CheckpointInfo, CheckpointAuthor } from "./checkpoint.js";
