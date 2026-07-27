# OmniHarness

> Local-first, model-agnostic desktop agent harness. One runtime for coding agents,
> knowledge work, browser automation, and desktop computer use — with any model.
>
> **[中文 README](./README.zh-CN.md)**

**Status: under active construction.** See [PROGRESS.md](./PROGRESS.md) for the true,
test-backed state of the product and [KNOWN_ISSUES.md](./KNOWN_ISSUES.md) for real limits.

## What it is

OmniHarness is built around a single local **Agent Daemon** that owns all state
(sessions, tasks, tools, approvals, memory, automations). Every client — TUI, desktop
GUI, CLI, remote channel — connects to that daemon over a versioned local RPC protocol.
There is exactly one agent loop (`packages/runtime-pi`, aligned with the upstream
[Pi](https://github.com/earendil-works/pi) architecture), one policy engine, and one
schema-driven configuration system.

- **Model-agnostic**: OpenAI, Anthropic, Gemini, OpenRouter, Azure, Bedrock, Mistral,
  Groq, xAI, Kimi, MiniMax, DeepSeek, Zhipu, Aliyun, Volcano, Ollama, LM Studio, any
  OpenAI-compatible endpoint, plus custom provider plugins.
- **Secure by default**: capability-based policy engine, sandboxed execution,
  approval workflows, OS keychain secret storage, full audit log.
- **Extensible**: tools, plugins, skills, and MCP servers are distinct concepts with
  declared permissions.

## Quick start

```bash
pnpm setup          # install + build all packages
pnpm dev:daemon     # start the local agent daemon
pnpm dev:tui        # start the terminal UI (in another shell)
omni --help         # CLI
pnpm verify         # full verification pipeline
```

## Layout

- `apps/` — `daemon`, `tui`, `cli`, `desktop`, `worker-host`, `computer-host`
- `packages/` — runtime, protocol, SDK, model gateway, policy, sandbox, memory,
  skills, automation, computer-use, browser, adapters, config schema, test harness
- `plugins/`, `skills/` — bundled and example extensions
- `docs/` — research audits, architecture, ADRs, user & developer guides, security
- `scripts/` — setup, verify, release, upstream sync

Branding (name, bundle ID, icons, copy) is centralized in [`brand.config.json`](./brand.config.json).

## License

Apache-2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
