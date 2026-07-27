# KNOWN ISSUES

Honest list of current limitations. Items are removed only when fixed and
covered by tests. Last updated: 2026-07-23.

## Platform / providers

- **AWS Bedrock provider is not implemented** — it requires SigV4 signing;
  `createProviderFromConfig` throws `NotImplementedProviderError` with a clear
  message. Every other preset (18) works through the OpenAI-compatible or
  Anthropic wire protocols.
- **Azure OpenAI** works via options-driven URL construction but has no
  live smoke test in CI (no credentials).
- Vision/image attachments: gateway `ChatMessage` has no image part yet;
  attachments are passed as text placeholders. (runtime-pi README)

## Computer use

- macOS input driver uses osascript/JXA + screencapture: the scripts are
  availability-tested but a full click/keyboard smoke on a real desktop has
  not been automated. First real run needs macOS Accessibility + Screen
  Recording permissions granted by the user.
- Linux driver supports X11 (xdotool/scrot); Wayland reports
  `available=false` with a diagnostic instead of guessing.

## Automations / policy

- `PolicyEngine` user rules live in the DB; the daemon loads them per
  evaluation. `policy.set` currently appends profile-scope rules only (no
  replace UI yet).
- `rememberScope` on approvals is persisted but the daemon does not yet
  grant allow_for_workspace/always_allow semantics beyond the current run.
- The FileWatcher test is timing-sensitive under heavy parallel load
  (fs.watch delivery latency); it passes consistently in isolation.

## Channels / remote

- The OpenClaw adapter is a fully tested library (59 tests) including the
  ACP runtime, forged-key defense and approval relay. Running it as a
  persistent daemon-managed process (supervision, auto-start) is not wired
  yet; `channel.pair` stores the channel record and prints setup instructions.
- Telegram/Slack/Discord connect through the generic webhook connector +
  formatters; native per-network connectors are not implemented.

## Packaging

- Desktop installers: electron-builder config exists; macOS unsigned build
  works, Windows/Linux installers are CI-only (untested locally).
- No code signing certificates in this environment — signing pipeline is
  documented (docs/security/SIGNING.md) but unsigned test builds ship.

## Misc

- `pnpm verify` "format check" stage requires prettier 3; enforced in CI.
- Node prints an experimental-warning for node:sqlite on every daemon start
  (harmless, Node 24).
