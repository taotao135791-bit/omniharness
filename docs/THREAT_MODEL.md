# OmniHarness Threat Model

Status: v1, evolving with implementation. Security tests live in
`packages/test-harness/src/security/` and run via `pnpm test:security`.

## 1. Assets

- User source code and workspace files (confidentiality, integrity)
- API keys and secrets (OS keychain / secret-store)
- Conversation history, memory entries, user profile data
- Machine integrity (shell access, filesystem, processes)
- User accounts reachable through channels (Telegram/Slack/...) and browser sessions
- Money (paid APIs, potential payment flows)

## 2. Actors

- **User** — trusted, but protected from accidental irreversible actions.
- **Models** — untrusted output generators. Any model output is data until validated.
- **External content** — web pages, emails, documents, channel messages, tool output:
  untrusted input, a prompt-injection vector.
- **Channels/remote nodes** — semi-trusted after pairing; messages are untrusted content.
- **Plugins/skills** — third-party code or instructions; least privilege.
- **Local network attackers** — daemon binds loopback; no unauthenticated remote access.

## 3. Trust boundaries

1. Model output → tool call arguments (schema validation, policy, sandbox).
2. External content → context builder (never promoted to instructions/permissions).
3. Channel message → session routing (pairing + allowlist; session id ≠ auth).
4. Plugin code → daemon (declared permissions, isolated host, crash containment).
5. Client → daemon RPC (loopback, per-install auth token, version negotiation).
6. Agent → secrets (secret-store mediates; secure-fill for credentials).

## 4. Core mitigations

| Threat | Mitigation | Where |
| --- | --- | --- |
| Prompt injection escalates privileges | Content is data; policy decisions never derived from content; tool args re-validated | tool-runtime, policy-engine |
| Malicious skill/plugin exfiltrates secrets | Declared capabilities, unsigned warnings, secret-store ref model, no env leakage | plugin-sdk, sandbox env filter |
| Path traversal / symlink escape | realpath boundary checks in workspace-manager; sandbox mounts | workspace-manager, sandbox-engine |
| Shell injection | argv arrays only, command policy patterns, sandboxed execution | tool-runtime, sandbox-engine |
| Secret exfiltration via network | Domain allowlists, network-off default in sandbox, audit | policy-engine, sandbox-engine |
| SSRF / local port abuse | Network capability gating, loopback-only daemon, allowlist | policy-engine, daemon |
| Unauthorized gateway/channel use | Pairing, allowlists, per-channel profile/workspace mapping, rate limits | openclaw-adapter |
| Replay / IPC forgery | Per-install random auth token in a 0600 runtime file; event seq monotonic | daemon, agent-protocol |
| Automation bypassing approvals | Automations get their own stricter policy scope; no silent grants | automation-engine, policy-engine |
| Sub-agent privilege escalation | Child policy scope ⊆ parent scope, enforced at creation | agent-orchestrator |
| Supply chain (plugins) | Integrity hashes, signature support, permission diff on update | plugin-sdk |
| Data loss | WAL, migrations with rollback, backups, checkpoints, non-git snapshots | session-store, workspace-manager |

## 5. Approval classes

- **Always required**: payments, message sending, credential entry, deletion outside
  workspace, system settings, git push, software install.
- **Default-ask**: shell, network, computer use, browser actions, file writes outside
  workspace.
- **Default-allow (scoped)**: reads/writes inside the active workspace.
- **Never allowed silently**: secret.read by tools/plugins (explicit user action only).

## 6. Audit

Every security-relevant decision appends to `audit_events` (who/what/when/decision/
target/scope). The `security.audit` diagnostics command replays configuration weak
points: wildcard allows, unsigned plugins with secrets, allow-always rules, world-
readable data dirs, sandbox=none environments.

## 7. Out of scope (v1)

- Defense against a fully compromised host OS user account.
- Multi-user / networked daemon deployments (loopback single-user only).
- Hardware attestation for remote nodes.
