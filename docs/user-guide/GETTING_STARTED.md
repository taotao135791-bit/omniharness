# Getting Started with OmniHarness

OmniHarness is a local-first agent harness: one daemon owns all state, and you
drive it from the TUI, the desktop app, or the CLI — with any model provider.

## Install (from source, unsigned test build)

Prerequisites: Node.js ≥ 22.12 (24 recommended), pnpm 10, git.

```bash
git clone https://github.com/taotao135791-bit/omniharness.git
cd omniharness
pnpm setup            # env check + install + build everything
pnpm release:local    # produces release/omniharness-<version>.tar.gz
```

Or run everything from the repo without installing.

## 1. Start the daemon

```bash
pnpm dev:daemon       # or: omniharnessd
```

On first start the daemon creates `~/.omniharness/` with a SQLite database,
an auth token (0600), and a runtime file clients use to connect. Everything
stays on 127.0.0.1 — nothing is exposed to the network.

## 2. Add a model provider

```bash
omni provider add --kind openai --name "OpenAI" --api-key sk-...
omni provider add --kind anthropic --name "Anthropic" --api-key sk-ant-...
omni provider add --kind ollama --name "Local Ollama"        # no key needed
omni provider add --kind openai-compatible --name "My Gateway" --base-url http://localhost:8080/v1
omni provider test --provider <id>
omni model list
```

API keys go to your OS keychain (or the encrypted-file fallback) — never to a
plain JSON file. Presets exist for OpenAI, Anthropic, Gemini, OpenRouter, Azure,
Mistral, Groq, xAI, Kimi, MiniMax, DeepSeek, Zhipu, Aliyun, Volcano, Ollama and
LM Studio.

## 3. Your first task

```bash
omni project create demo
omni workspace register --project <id> --roots $PWD
omni session create --workspace <id> --title "first task"
omni run start --session <id> "explain this repo's layout"
```

The same flow works interactively in the TUI (`omni-tui`) and the desktop app.

## 4. The TUI

```bash
pnpm dev:tui          # or: omni-tui
```

- `ctrl+p` — command palette (everything is reachable from here)
- `ctrl+1..4` — sessions / diff / models / logs
- `esc` — interrupt a running agent
- `/model`, `/diff`, `/checkpoint create` — slash commands in chat

## 5. Approvals and safety

The first time the agent wants to run a shell command or touch the network,
you get an approval prompt (TUI, GUI, CLI `omni approval list` and even your
phone via channels). Nothing high-risk happens silently. See
[../THREAT_MODEL.md](../THREAT_MODEL.md).

## 6. Where things live

| What                       | Where                                          |
| -------------------------- | ---------------------------------------------- |
| Database, events, settings | `~/.omniharness/omniharness.db`                |
| Auth token                 | `~/.omniharness/.auth-token` (0600)            |
| Logs                       | `~/.omniharness/daemon.log` (NDJSON, redacted) |
| Artifacts (large outputs)  | `~/.omniharness/artifacts/`                    |
| Export everything          | `omni data export --target-dir <dir>`          |
| Delete everything          | `omni data delete --confirm true`              |

## Next steps

- [Providers & models](../developer-guide/PROVIDERS.md)
- [Writing tools, plugins and skills](../developer-guide/EXTENDING.md)
- [Architecture](../ARCHITECTURE.md)
