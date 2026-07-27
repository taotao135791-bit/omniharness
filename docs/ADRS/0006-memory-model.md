# ADR-0006: Memory model — typed, provenance-first, approval-gated

Status: Accepted (2026-07-23)

## Context

Hermes' built-in memory is two §-delimited text files with no metadata; its FTS
session recall and the holographic plugin's hybrid scoring are the valuable parts
(audit: docs/research/HERMES_AUDIT.md). Agent-written "facts" about users are a
real correctness and privacy hazard.

## Decision

Seven typed memory kinds (working/session/episodic/semantic/userPreference/
project/procedural). Every entry carries provenance (source session, creator,
evidence refs), confidence, scope (profile/project isolation) and an approval
flag. Agent-proposed memories are pending (confidence ≤ 0.7) until a human
approves; rejection archives, never deletes. Retrieval = FTS5 bm25 × recency
decay × confidence (0.5/0.3/0.2). Curation archives expired/stale/duplicate
entries; only explicit user delete purges.

## Consequences

- Nothing a model inferred is ever silently treated as user fact.
- Profile isolation is enforced in SQL, not in prompts.
- Hermes imports lose provenance (their format has none) and are marked `import`.
