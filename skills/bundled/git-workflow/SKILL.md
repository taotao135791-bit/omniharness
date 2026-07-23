---
name: git-workflow
description: Safe git operations for agents — branching, committing, worktrees, and recovery. Use for any non-trivial git task.
version: 1.0.0
requiredCapabilities: ["shell.exec"]
---

# Git Workflow

- Never run `git commit`, `git push`, `git reset --hard`, `git rebase` without an explicit user instruction for that exact operation.
- Before destructive-sounding commands, create a checkpoint (`checkpoint.create`).
- Prefer per-task worktrees over switching branches in the user's checkout.
- Commit messages follow the repo's existing style (inspect `git log` first).
- When a merge conflicts, stop and present the conflict rather than resolving silently.
