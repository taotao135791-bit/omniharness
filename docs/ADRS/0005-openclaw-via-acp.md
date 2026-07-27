# ADR-0005: OpenClaw integration via the ACP seam

Status: Accepted (2026-07-23)

## Context

OpenClaw (audited @ cca67fc8) is a gateway with channel plugins and node pairing.
Its `AcpRuntime` interface (`ensureSession` + streaming `runTurn`) is exactly how
their own `acpx` extension wraps external agents (claude/codex subprocesses).

## Decision

`packages/openclaw-adapter` implements an ACP runtime backed by the OmniHarness
daemon (via client-sdk). OpenClaw session keys are treated strictly as routing
labels; authorization (allowlists, pairing, profile/workspace mapping) is
re-derived in the adapter on every message. Channel secrets live in our
secret-store, never in OpenClaw's plaintext config.

## Consequences

- No OpenClaw code runs our agent loop; no OpenClaw process is required for core use.
- Gateway protocol version is pinned in the adapter and covered by contract tests.
- Tool policy caveat (per audit): ACP does not enforce tool policy across the
  boundary — so all enforcement stays in OUR tool-runtime/policy-engine, and the
  adapter maps remote approvals onto our approval-engine.
