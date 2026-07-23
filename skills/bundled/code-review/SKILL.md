---
name: code-review
description: Review a diff or set of files for correctness, security and style issues. Use when asked to review code changes.
version: 1.0.0
requiredCapabilities: ["fs.read"]
---

# Code Review

When reviewing changes:

1. Read the full diff first (`diff.get`); do not review files in isolation from their change.
2. Classify each finding: **bug** (breaks behavior), **security** (injection, secret exposure, unsafe permissions), **style** (readability, convention).
3. For every finding cite `path:line` and propose a concrete fix.
4. Check the change against the surrounding conventions, not your defaults.
5. End with a verdict: approve / approve with nits / request changes, and one-line rationale.
