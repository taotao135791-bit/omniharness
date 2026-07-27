# ADR-0003: The daemon owns all state

Status: Accepted (2026-07-23)

## Context

TUI, GUI, CLI and remote channels must observe and control the same sessions.
If clients wrote the database directly, locking, migrations and event ordering
would be unenforceable.

## Decision

`apps/daemon` is the only process that opens the SQLite database and the only
implementation of the command catalog in `packages/agent-protocol`. Clients
connect over loopback WebSocket with a per-install auth token, negotiate protocol
versions, and subscribe to seq-ordered events with reconnect catch-up
(`events.since`). GUI never wraps or parses TUI.

## Consequences

- Crash recovery has exactly one implementation (daemon startup reconciliation).
- Every feature must exist as a daemon command + SDK method before any UI ships it.
