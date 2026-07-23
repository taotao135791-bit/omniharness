# ADR-0001: Pi is the single agent kernel

Status: Accepted (2026-07-23)

## Context
The product brief references three upstream projects (Pi, OpenClaw, Hermes). Each has
its own agent loop. Running three loops means three context formats, three permission
models and unresolvable behavior drift.

## Decision
`@earendil-works/pi-agent-core` (MIT, audited in docs/research/PI_AUDIT.md) is the only
agent loop. It is consumed as an npm dependency behind `packages/runtime-pi`.
OpenClaw capabilities are integrated as an adapter (channels, gateway, nodes).
Hermes capabilities are integrated as services (memory, skill learning, checkpoints).

## Consequences
- One context format, one compaction strategy, one streaming model.
- Pi upgrades flow through runtime-pi's adapter tests; no fork exists.
- Any capability Pi lacks (permissions, subagents) is built in our packages, not patched into Pi.
