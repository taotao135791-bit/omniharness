# OmniHarness Feature Matrix

Legend: ✅ done & tested · 🟡 partial · ⬜ planned · ❌ not planned (with reason).
"Tests" links to the covering test file. Updated as work lands — claims require tests.

## Core platform

| Capability | Reference | Implementation | Status | Tests | Parity | Known limits |
| --- | --- | --- | --- | --- | --- | --- |
| Single agent loop (Pi kernel) | Pi | `packages/runtime-pi` | ⬜ | — | — | — |
| Local agent daemon + RPC | Codex Desktop | `apps/daemon`, `packages/agent-protocol` | ⬜ | — | — | — |
| Versioned event protocol + reconnect catch-up | Pi RPC | `packages/agent-protocol` (event_log seq) | 🟡 | — | — | contract defined, daemon pending |
| TypeScript client SDK | Claude Code SDK | `packages/client-sdk` | ⬜ | — | — | — |
| Schema-driven settings | — | `packages/config-schema` | ✅ | `packages/config-schema/src/index.test.ts` | n/a | — |
| Centralized branding | — | `brand.config.json`, `config-schema/src/brand.ts` | ✅ | — | n/a | — |
| SQLite state + event log + migrations | Pi sqlite | `packages/session-store` | 🟡 | — | — | — |

## Models

| Capability | Reference | Implementation | Status | Tests | Parity | Known limits |
| --- | --- | --- | --- | --- | --- | --- |
| Model capability registry | — | `packages/model-gateway` | 🟡 | — | — | — |
| OpenAI-compatible provider (15+ presets) | Codex providers | `model-gateway` | 🟡 | — | — | — |
| Anthropic provider | Claude Code | `model-gateway` | 🟡 | — | — | — |
| Local models (Ollama, LM Studio) | — | `model-gateway` presets | 🟡 | — | — | — |
| Role-based model routing | — | `model-gateway` router | 🟡 | — | — | — |
| Fallback + retry + backoff | — | `model-gateway` router | 🟡 | — | — | — |
| Weak-model tool-call compat | — | `model-gateway` compat layer | 🟡 | — | — | — |
| OS keychain secret storage | Codex auth | `packages/secret-store` | 🟡 | — | — | — |

## Security

| Capability | Reference | Implementation | Status | Tests | Parity | Known limits |
| --- | --- | --- | --- | --- | --- | --- |
| Capability policy engine (layered scopes) | Claude Code permissions | `packages/policy-engine` | 🟡 | — | — | — |
| Approval workflow | Codex approvals | `packages/approval-engine` | 🟡 | — | — | — |
| Sandbox backends (seatbelt/bwrap/docker/ssh) | Codex sandbox | `packages/sandbox-engine` | 🟡 | — | — | — |
| Audit log | — | `session-store` audit_events | 🟡 | — | — | — |
| Threat model | — | `docs/THREAT_MODEL.md` | ✅ | — | n/a | — |

## Workflows

| Capability | Reference | Implementation | Status | Tests | Parity | Known limits |
| --- | --- | --- | --- | --- | --- | --- |
| Core tools (fs/shell/search) | Pi tools | `packages/tool-runtime` | 🟡 | — | — | — |
| Git engine + worktrees | Codex Desktop | `packages/git-engine` | 🟡 | — | — | — |
| Hunk-level diff accept/reject | Codex Desktop | `git-engine` + daemon | 🟡 | — | — | — |
| Non-git snapshots/rollback | — | `packages/workspace-manager` | 🟡 | — | — | — |
| Multi-agent orchestration | Codex multi-agent | `packages/agent-orchestrator` | ⬜ | — | — | — |
| Memory engine (Hermes-inspired) | Hermes | `packages/memory-engine` | ⬜ | — | — | — |
| Skill system + learning loop | Pi/Claude skills | `packages/skill-engine` | ⬜ | — | — | — |
| Automations (cron/triggers) | Codex scheduled tasks | `packages/automation-engine` | ⬜ | — | — | — |
| Computer Use | Claude computer use | `packages/computer-use` | ⬜ | — | — | — |
| Browser runtime | OpenClaw browser | `packages/browser-runtime` | ⬜ | — | — | — |
| OpenClaw channels/nodes adapter | OpenClaw | `packages/openclaw-adapter` | ⬜ | — | — | — |
| Pi/Hermes importers | — | `packages/hermes-importer`, daemon import | ⬜ | — | — | — |
| Plugins (manifest, permissions) | Pi extensions | `packages/plugin-sdk`, `packages/extension-host` | ⬜ | — | — | — |
| MCP servers | Codex/Claude MCP | `packages/tool-runtime/mcp` | ⬜ | — | — | — |

## Clients

| Capability | Reference | Implementation | Status | Tests | Parity | Known limits |
| --- | --- | --- | --- | --- | --- | --- |
| TUI (21 views) | Pi TUI | `apps/tui` | ⬜ | — | — | — |
| CLI (full parity) | Codex CLI | `apps/cli` | ⬜ | — | — | — |
| Desktop GUI (Electron) | Codex Desktop | `apps/desktop` | ⬜ | — | — | — |

## Release

| Capability | Reference | Implementation | Status | Tests | Parity | Known limits |
| --- | --- | --- | --- | --- | --- | --- |
| Installers (mac/win/linux) | Codex Desktop | `scripts/release`, electron-builder | ⬜ | — | — | — |
| `pnpm verify` pipeline | — | `scripts/verify/verify.mjs` | ⬜ | — | — | — |
| Upstream sync (Pi) | — | `scripts/upstream/sync.mjs` | ⬜ | — | — | — |
