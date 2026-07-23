# DECISIONS

Architecture and product decisions, newest last. Significant decisions also get an ADR
in `docs/ADRS/`.

- 2026-07-23 — Product codename `OmniHarness`; all branding centralized in `brand.config.json`.
- 2026-07-23 — pnpm workspace monorepo, Node.js >= 22.12, TypeScript strict everywhere.
- 2026-07-23 — Exactly one agent loop lives in `packages/runtime-pi`; OpenClaw and Hermes
  concerns are adapters/services, never parallel loops (see docs/ARCHITECTURE.md).
