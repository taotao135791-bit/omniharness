# Upstream Strategy

How OmniHarness consumes, tracks and stays upgradeable against its three upstreams.
Audits: [PI_AUDIT](research/PI_AUDIT.md) · [OPENCLAW_AUDIT](research/OPENCLAW_AUDIT.md) · [HERMES_AUDIT](research/HERMES_AUDIT.md).

## Pi (`earendil-works/pi`, MIT, audited @ 9b3a205, v0.81.1)

**Relationship: dependency, not fork.**

- Consume `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-tui`
  as versioned npm dependencies.
- All Pi access flows through `packages/runtime-pi` (loop) and the TUI's component
  adapters. No other package imports `@earendil-works/*`.
- Pi's extension system (jiti-loaded TS modules, ~30 events) is supported as a plugin
  source via `extension-host`, so existing Pi extensions keep working.
- Pin discipline: `scripts/upstream/pi-upstream.json` records the audited commit;
  `pnpm upstream:sync` diffs the packages we depend on and re-runs the adapter
  contract tests before any version bump.
- Escape hatch: if a change cannot be expressed through Pi's extension seams, it lands
  as a patch in `patches/` with: upstream commit, reason, test, and a sync-script check.
  No silent divergence. (Currently zero patches.)
- Risk noted in audit: single-maintainer velocity, past breaking renames. Mitigation:
  runtime-pi is the single seam; contract tests define the exact surface we rely on.

## OpenClaw (`openclaw/openclaw`, MIT, audited @ cca67fc8, v2026.7.2)

**Relationship: integration via adapter, pinned protocol.**

- We do not embed OpenClaw's agent. The OmniHarness daemon is exposed to OpenClaw's
  gateway through an `AcpRuntime` implementation (`ensureSession` + streaming
  `runTurn`), the same seam their `acpx` extension uses — per audit §6.
- `packages/openclaw-adapter` owns: gateway connection (WS+HTTP, challenge/connect
  handshake), channel message mapping (`MsgContext` → our session/routing model),
  node pairing surface, and remote approval delivery.
- Session keys (`agent:<id>:<channel>:...`) are routing labels only; authorization is
  re-derived per message from pairing + allowlists (their SECURITY.md says the same).
- Version-locked: pin the gateway protocol schema version; vendor the frame schema
  for defensive decoding. Upgrade = pin bump + adapter contract tests.
- Secrets: we never adopt their plaintext-config default; channel tokens live in
  our secret-store.

## Hermes (`NousResearch/hermes-agent`, MIT, audited @ 7168845, v0.19.0)

**Relationship: ideas + data import only.**

- No code reuse; the agent loop (`conversation_loop.py`) is explicitly out.
- Adopted ideas: episodic session recall over FTS5 (their `state.db` pattern),
  provenance-tagged agent-created content (`created_by: agent` → our
  `approvedByUser=false` pending state), read-before-write and archive-instead-of-delete
  guards, idle curation lifecycle (stale→archive with snapshots).
- Scored retrieval follows their holographic plugin's hybrid scoring idea
  (FTS + similarity + trust weighting), reimplemented in `memory-engine`.
- Importers (`hermes-importer`) read `MEMORY.md`/`USER.md` (§-delimited, sanitized),
  `state.db` sessions, and `skills/**/SKILL.md` into our schemas. Provenance is marked
  `import` since the §-format carries none.

## Update cadence

- Pi: track releases; sync script + contract tests gate each bump.
- OpenClaw: track gateway protocol versions only; channels update independently.
- Hermes: no ongoing tracking; importer targets the audited schema version and
  fails loudly on schema drift.
