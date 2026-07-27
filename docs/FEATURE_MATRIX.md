# OmniHarness Feature Matrix

Legend: ✅ done & tested · 🟡 partial · ⬜ planned.
"Tests" links the covering test suite. Claims require tests; limits are honest.
State as of 2026-07-23 (verified by `pnpm verify`).

## Core platform

| Capability                                  | Reference     | Implementation                                     | Status | Tests                            | Parity  | Known limits                                   |
| ------------------------------------------- | ------------- | -------------------------------------------------- | ------ | -------------------------------- | ------- | ---------------------------------------------- |
| Single agent loop (Pi kernel)               | Pi            | `packages/runtime-pi` (real pi-agent-core `Agent`) | ✅     | `runtime-pi` 6 tests             | aligned | compaction is ours (threshold + summarizer)    |
| Local agent daemon + RPC                    | Codex Desktop | `apps/daemon`                                      | ✅     | `main.test.ts` + `run-e2e` (8)   | aligned | —                                              |
| Versioned event protocol + reconnect replay | Pi RPC        | `agent-protocol` + `event_log` seq                 | ✅     | daemon replay test               | aligned | —                                              |
| TypeScript client SDK                       | Claude SDK    | `packages/client-sdk`                              | ✅     | 3 tests                          | aligned | —                                              |
| Schema-driven settings                      | —             | `packages/config-schema`                           | ✅     | 10 tests                         | n/a     | —                                              |
| Centralized branding                        | —             | `brand.config.json`                                | ✅     | —                                | n/a     | —                                              |
| SQLite state + event log + migrations       | Pi sqlite     | `packages/session-store` (30 tables)               | ✅     | 25 tests                         | aligned | —                                              |
| Observability (spans, redacted logs)        | —             | `packages/observability`                           | ✅     | 4 tests                          | aligned | —                                              |
| Artifact store                              | —             | `packages/artifact-store`                          | ✅     | 2 tests                          | aligned | —                                              |

## Models

| Capability                               | Reference       | Implementation             | Status | Tests     | Parity  | Known limits                |
| ---------------------------------------- | --------------- | -------------------------- | ------ | --------- | ------- | --------------------------- |
| Model capability registry                | —               | `model-gateway`            | ✅     | 43 tests* | aligned | \*shared suite              |
| OpenAI-compatible provider (15+ presets) | Codex providers | `model-gateway` SSE        | ✅     | 43 tests  | aligned | —                           |
| Anthropic provider                       | Claude Code     | `model-gateway`            | ✅     | 43 tests  | aligned | —                           |
| Local models (Ollama, LM Studio)         | —               | presets                    | ✅     | 43 tests  | aligned | —                           |
| Role-based routing (11 roles)            | —               | `ModelRouter`              | ✅     | 43 tests  | aligned | —                           |
| Fallback + retry + backoff               | —               | `ModelRouter`              | ✅     | 43 tests  | aligned | —                           |
| Weak-model tool-call compat              | —               | `ToolCallCompatLayer`      | ✅     | 43 tests  | aligned | —                           |
| OS keychain secrets                      | Codex auth      | `packages/secret-store`    | ✅     | 16 tests  | aligned | —                           |
| AWS Bedrock                              | —               | —                          | ⬜     | —         | ❌      | needs SigV4; throws cleanly |

## Security

| Capability             | Reference      | Implementation            | Status | Tests           | Parity  | Known limits                        |
| ---------------------- | -------------- | ------------------------- | ------ | --------------- | ------- | ----------------------------------- |
| Capability policy engine | Claude perms | `packages/policy-engine`  | ✅     | 43 tests        | aligned | —                                   |
| Approval workflow      | Codex approvals | `packages/approval-engine` + daemon | ✅ | 17 tests + e2e  | aligned | rememberScope semantics partial     |
| Sandbox backends       | Codex sandbox  | `packages/sandbox-engine` | ✅     | 27 tests        | aligned | bwrap/docker/ssh not host-tested    |
| Audit log              | —              | `audit_events` table      | ✅     | session-store   | aligned | —                                   |
| Security test suite    | —              | `test-harness/security`   | ✅     | 10 tests        | aligned | —                                   |
| Threat model           | —              | `docs/THREAT_MODEL.md`    | ✅     | —               | n/a     | —                                   |

## Workflows

| Capability                    | Reference            | Implementation                        | Status | Tests          | Parity  | Known limits                          |
| ----------------------------- | -------------------- | ------------------------------------- | ------ | -------------- | ------- | ------------------------------------- |
| Core tools (fs/shell/search)  | Pi tools             | `packages/tool-runtime`               | ✅     | 47 tests       | aligned | —                                     |
| Git engine + worktrees        | Codex Desktop        | `packages/git-engine`                 | ✅     | 21 tests       | aligned | —                                     |
| Hunk-level diff accept/reject | Codex Desktop        | `git-engine` + daemon                 | ✅     | 21 tests       | aligned | —                                     |
| Non-git snapshots/rollback    | —                    | `packages/workspace-manager`          | ✅     | 18 tests       | aligned | daemon restore wiring pending         |
| Multi-agent orchestration     | Codex multi-agent    | `agent-orchestrator` + daemon task.\* | ✅     | 20 tests       | aligned | —                                     |
| Memory engine                 | Hermes               | `packages/memory-engine`              | ✅     | 15 tests       | exceeds | —                                     |
| Skill system + learning loop  | Pi/Claude skills     | `packages/skill-engine`               | ✅     | 48 tests       | aligned | registry install pending              |
| Automations (cron/triggers)   | Codex scheduled      | `automation-engine` + daemon          | ✅     | 108 tests      | aligned | webhook trigger untested              |
| Computer Use                  | Claude computer use  | `packages/computer-use`               | ✅     | 30 tests       | aligned | real-desktop smoke manual             |
| Browser runtime (own CDP)     | OpenClaw browser     | `packages/browser-runtime`            | ✅     | 32 tests       | aligned | ws:// only                            |
| OpenClaw adapter (ACP)        | OpenClaw             | `packages/openclaw-adapter`           | ✅     | 59 tests       | aligned | process supervision not wired         |
| Pi/Hermes/MCP importers       | —                    | `packages/hermes-importer` + daemon   | ✅     | 41 tests       | aligned | —                                     |
| Plugins (sandboxed)           | Pi extensions        | `plugin-sdk` + `extension-host`       | ✅     | 35 tests       | aligned | signatures structural only            |
| MCP client                    | Codex/Claude MCP     | —                                     | ⬜     | —            | ❌      | config import only; protocol not impl |

## Clients

| Capability            | Reference     | Implementation    | Status | Tests                 | Parity  | Known limits                    |
| --------------------- | ------------- | ----------------- | ------ | --------------------- | ------- | ------------------------------- |
| TUI                   | Pi TUI        | `apps/tui` (pi-tui) | ✅   | 42 tests              | aligned | 21-view breadth partial         |
| CLI                   | Codex CLI     | `apps/cli` (omni) | ✅     | 2 + bundle smoke      | aligned | —                               |
| Desktop GUI (Electron) | Codex Desktop | `apps/desktop`    | 🟡     | main-process typecheck | partial | full views in progress          |

## Release

| Capability                  | Reference     | Implementation             | Status | Tests                 | Parity  | Known limits                         |
| --------------------------- | ------------- | -------------------------- | ------ | --------------------- | ------- | ------------------------------------ |
| Standalone CLI/daemon bundle | —            | `scripts/release` (esbuild) | ✅    | tarball smoke (manual) | aligned | —                                    |
| OS installers               | Codex Desktop | electron-builder           | 🟡     | CI job defined        | partial | unsigned; mac/win/linux via CI only  |
| `pnpm verify`               | —             | `scripts/verify/verify.mjs` | ✅    | passes 2026-07-23     | aligned | —                                    |
| Upstream sync (Pi)          | —             | `scripts/upstream/sync.mjs` | ✅    | —                     | aligned | —                                    |
