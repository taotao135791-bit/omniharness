# OmniHarness Architecture

Status: living document. Updated whenever a structural decision lands.
Decision log: [../DECISIONS.md](../DECISIONS.md) and [ADRS/](./ADRS/).

## 1. One kernel, many clients

```
TUI Client ──────┐
Desktop GUI ─────┤
CLI Client ──────┤
Remote Client ───┼── Local Agent Daemon (apps/daemon)
SDK/RPC Client ──┘          │
                            ├── Pi Runtime (packages/runtime-pi — wraps @earendil-works/pi-agent-core)
                            ├── Session Service (packages/session-store)
                            ├── Model Router (packages/model-gateway)
                            ├── Tool Runtime (packages/tool-runtime)
                            ├── Workspace Manager (+ packages/git-engine)
                            ├── Policy Engine (+ approval-engine, sandbox-engine)
                            ├── Memory Engine (packages/memory-engine)
                            ├── Skill Engine (packages/skill-engine)
                            ├── Automation Engine (packages/automation-engine)
                            └── Gateway Adapter (packages/openclaw-adapter)
```

- **The daemon owns all state.** Clients are dumb renderers over the versioned
  RPC protocol in `packages/agent-protocol`. No client talks to the database,
  the filesystem policy, or a model provider directly.
- **One agent loop.** Pi is the only agent runtime. OpenClaw concerns (gateway,
  channels, remote nodes) are an *adapter*; Hermes concerns (long-term memory,
  skill learning, checkpoints) are *services*. Neither runs a parallel loop.
- **GUI never wraps TUI.** Both implement the same `client-sdk` contract.

## 2. Upstream strategy (Pi)

From [research/PI_AUDIT.md](research/PI_AUDIT.md): Pi (`earendil-works/pi`, MIT)
ships `@earendil-works/pi-ai` (multi-provider LLM API), `@earendil-works/pi-agent-core`
(agent loop, Agent class, compaction, execution-env abstraction), `@earendil-works/pi-tui`
(differential-rendering TUI toolkit) and `@earendil-works/pi-coding-agent` (CLI harness).

We consume Pi as **npm dependencies** behind our own interfaces:

- `runtime-pi` adapts pi-agent-core's loop into our daemon: our tools, our policy
  pipeline, our event protocol. If Pi is ever unavailable or diverges, runtime-pi is
  the single seam.
- We do **not** fork Pi. If a change is impossible via extensions, it lands in
  `patches/` with a recorded upstream commit, a reason, and a test
  (see `scripts/upstream/sync.mjs`).

## 3. Schema-driven configuration

`packages/config-schema` holds the single settings schema (`SETTINGS_SCHEMA`).
From it we generate: validation, defaults, CLI flags, TUI/GUI settings forms,
Markdown docs, and migrations. Plugin manifests, model capabilities, skills and
automations have structural validators in the same package.

Config precedence: product defaults < global < profile < workspace < project < session < one-time.

## 4. Security architecture

See [THREAT_MODEL.md](THREAT_MODEL.md). Every tool call flows:

```
Agent Tool Request
→ Schema Validation (tool-runtime)
→ Policy Evaluation (policy-engine, layered scopes)
→ Risk Classification (low/medium/high/critical)
→ Approval Decision (approval-engine, session/workspace grants)
→ Sandbox Selection (sandbox-engine: seatbelt / bwrap / docker / ssh / null+warning)
→ Execution
→ Result Sanitization (truncate, artifact, secret scrub)
→ Audit Event (append-only audit_events + event_log)
```

Key invariants:

- Secrets live in the OS keychain (`secret-store`); never in prompts or plain JSON.
- Sub-agents get at most their parent's permissions.
- Automations run with their own, stricter permission set.
- External content (web pages, emails, channel messages, tool output) is untrusted:
  it can never promote itself to system instructions or permissions.
- Session/channel IDs are routing labels, never authorization tokens.

## 5. Data model

Single SQLite database (WAL) per data dir, owned by the daemon:
`packages/session-store/src/migrations.ts` is the source of truth (schema v1 covers
profiles → audit_events, ~28 tables). An append-only `event_log` with monotonic `seq`
powers live subscriptions and reconnect catch-up (`events.since`).

## 6. Multi-model system

`model-gateway` exposes one `ModelProvider` interface. OpenAI-compatible and Anthropic
wire protocols are first-class; ~18 providers map onto presets (base URL + env key).
Every model declares `ModelCapabilities`; the `ModelRouter` binds models to roles
(primary, planner, executor, reviewer, vision, computerUse, summarizer,
memoryExtractor, skillLearner, embedding, fastUtility), handles retries with
backoff, rate-limit fallback chains, health checks and budget enforcement.
Models without native tool calling run through a deterministic compat layer.

## 7. Multi-agent orchestration

`agent-orchestrator` decomposes objectives into `AgentTask` graphs (dependencies,
budgets, allowed tools, isolated contexts, git worktrees). The orchestrator runs
tasks through the *same* daemon runtime with per-task policy scopes. Deadlock,
zombie and loop detection are part of the scheduler.

## 8. Computer Use & Browser

`computer-use` defines a provider interface (capture → inspect → propose → policy
check → execute → verify) with macOS/Windows/Linux backends; `browser-runtime`
provides DOM/CDP, visual, and hybrid modes in isolated profiles. Both are tools
behind the policy engine, with extra approval classes for sensitive actions
(payments, messages, credentials — filled via secure-fill, never via prompt).

## 9. Packaging

`apps/desktop` is Electron + React with `contextIsolation`, no node integration,
and a minimal preload bridge that only exposes the client SDK. Installers via
electron-builder (macOS/Windows/Linux); signing pipeline documented in
`docs/security/SIGNING.md` and runnable without certificates for test builds.
