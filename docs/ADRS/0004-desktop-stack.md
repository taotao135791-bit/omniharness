# ADR-0004: Electron + React for the desktop GUI

Status: Accepted (2026-07-23)

## Context

The GUI needs an embedded terminal, rich diff views, streaming updates, tray,
global hotkeys and cross-platform installers. Tauri would add a Rust toolchain
(and a second language) without buying anything the product needs today.

## Decision

Electron + React + TypeScript. `contextIsolation: true`, `nodeIntegration: false`,
a minimal preload that exposes only the typed client SDK. All agent logic stays
in the daemon; the renderer is a pure client.

## Consequences

- Larger installers than Tauri; accepted.
- One language (TypeScript) across the whole product.
- Reconsidered only if installer size or memory becomes a measured problem.
