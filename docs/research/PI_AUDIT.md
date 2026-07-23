# Pi Upstream Audit

Source-level audit of the "Pi" agent harness for OmniHarness architecture planning.
Audit date: 2026-07-23. Audited from a `git clone --depth 1` into `tmp/upstream/pi` (gitignored, not committed).

## 1. Identity & version

- **Repo audited:** https://github.com/earendil-works/pi — it **exists** and is the real Pi project (Mario Zechner / badlogic's agent TUI, formerly `badlogic/pi-mono`; docs and config still reference `earendil-works/pi-mono` and npm scope `@mariozechner/*` in older material). It is the same codebase the user meant.
- **Commit:** `9b3a2059171bcc74ad9d2cadeea6d186776cf2db` (2026-07-22, "fix(coding-agent): isolate summarization requests")
- **Version:** all packages at **0.81.1** (npm scope `@earendil-works/*`)
- **License:** MIT (`LICENSE`, "Copyright (c) 2025 Mario Zechner"). No third-party NOTICE file; vendored deps are declared in `packages/coding-agent/npm-shrinkwrap.json`; `packages/coding-agent/src/core/export-html/vendor/` contains vendored JS for HTML export.
- **Monorepo:** npm workspaces, packages at version-locked `^0.81.1` internal ranges. Build order: tui → ai → agent → storage/sqlite-node → coding-agent → server. TypeScript with erasable-syntax-only rule, Biome for lint/format, `tsgo` for typecheck, vitest for tests.

## 2. Architecture map (real paths)

### Packages (`packages/`)

| Package | npm name | Role |
|---|---|---|
| `ai/` | `@earendil-works/pi-ai` | Unified multi-provider LLM API: message/model types, per-API stream implementations, OAuth, model catalog |
| `agent/` | `@earendil-works/pi-agent-core` | Provider-agnostic agent runtime: agent loop, `Agent` class, harness (session tree, compaction, skills, env abstraction, built-in tool impls) |
| `tui/` | `@earendil-works/pi-tui` | Terminal UI library with differential rendering; no external TUI framework — custom `Component` model |
| `coding-agent/` | `@earendil-works/pi-coding-agent` | The `pi` CLI: modes (interactive TUI, print, json, RPC), extension system, session manager, settings, skills/prompts/themes/packages loading, built-in coding tools |
| `server/` | `@earendil-works/pi-server` | Experimental headless server (supervisor, IPC, storage); explicitly unstable |
| `storage/sqlite-node/` | — | SQLite-backed session storage variant |

### Agent core (`packages/agent/src/`)

- `agent-loop.ts` — `agentLoop()`, `agentLoopContinue()`, `runAgentLoop()`, `runAgentLoopContinue()`. The main loop: outer loop over follow-up messages, inner loop over tool calls + steering messages. `streamAssistantResponse()` applies `transformContext` → `convertToLlm` → `streamFn`, then folds stream events into `message_start/update/end`. Tool calls execute via `executeToolCallsSequential`/`executeToolCallsParallel` (default parallel; per-tool `executionMode: "sequential"` forces sequential). Truncated (`stopReason === "length"`) tool calls are failed wholesale, never executed. `beforeToolCall` can block; `afterToolCall` can rewrite result content/details/isError/usage/terminate.
- `agent.ts` — `class Agent`: stateful wrapper. Owns transcript (`state.messages`), `steer()`/`followUp()` queues (`PendingMessageQueue`, modes `"all"`/`"one-at-a-time"`), `prompt()`, `continue()`, `abort()`, `waitForIdle()`, `subscribe(listener)`. Listeners are awaited in subscription order and included in run settlement.
- `types.ts` — `AgentEvent` union (`agent_start/end`, `turn_start/end`, `message_start/update/end`, `tool_execution_start/update/end`), `AgentLoopConfig`, `AgentTool`, `AgentMessage = Message | CustomAgentMessages[...]` (declaration-merging extension point).
- `stream-fn.ts` — default `StreamFn` (`Models.streamSimple`-shaped; contract: never throw, encode failures as protocol events with `stopReason: "error"|"aborted"`).
- `proxy.ts` — streaming proxy helpers.
- `harness/` — higher-level `AgentHarness` (`agent-harness.ts`, 1084 lines) with:
  - `types.ts` (958 lines): `FileSystem`, `Shell`, `ExecutionEnv` (backend-independent, `Result<T, FileError>`-returning, must-never-throw contract), session tree types, harness event types, `Skill`, `PromptTemplate`.
  - `session/session.ts` — `class Session<TMetadata>` over a `SessionStorage` interface; tree entries with `id`/`parentId`; `buildSessionContext()` replays the branch and applies compaction transform.
  - `session/jsonl-storage.ts`, `jsonl-repo.ts`, `memory-storage.ts`, `memory-repo.ts` — JSONL and in-memory storage backends implementing `SessionStorage`/`SessionRepo`.
  - `compaction/compaction.ts` (868 lines), `branch-summarization.ts`, `utils.ts`.
  - `env/nodejs.ts` (675 lines) — Node `ExecutionEnv` implementation.
  - `tools/` — harness-level `bash`, `read`, `edit`, `write`, `image` tool implementations written against `ExecutionEnv` (portable to sandboxes).
  - `skills.ts`, `prompt-templates.ts`, `system-prompt.ts`, `messages.ts`.

### AI package (`packages/ai/src/`)

- `types.ts` — `Model<TApi>` (id, name, api, provider, baseUrl, reasoning, `thinkingLevelMap`, input, cost with tiers, contextWindow, maxTokens, headers, `compat`), `Message` union (`UserMessage`/`AssistantMessage`/`ToolResultMessage`), content blocks (`TextContent`/`ThinkingContent`/`ImageContent`/`ToolCall`), `Usage`, `Tool<TParameters>` (TypeBox schema), `Context`, `StreamOptions`/`SimpleStreamOptions`, `ProviderStreams` (`stream`, `streamSimple`), `ProviderImages`.
- `api/` — one module per wire protocol, each exporting a uniform stream function: `anthropic-messages`, `openai-completions`, `openai-responses`, `openai-codex-responses`, `azure-openai-responses`, `google-generative-ai`, `google-vertex`, `bedrock-converse-stream`, `mistral-conversations`, `openrouter-images`, `pi-messages`, plus `.lazy.ts` wrappers for lazy loading.
- `providers/` — per-provider model catalogs and auth (`anthropic.ts`, `amazon-bedrock.ts`, etc.).
- `oauth.ts`, `auth/` — OAuth flows; `env-api-keys.ts` — env var API key resolution; `models.generated.ts` + `model-catalog.ts` — generated model registry; `compat.ts` — `streamSimple`, `clampThinkingLevel`, cross-API compat layer.

### TUI package (`packages/tui/src/`)

- `tui.ts` — `class TUI extends Container`, `interface Component` (`render(width): string[]`, `invalidate()`, optional `handleInput`, `dispose`), `Focusable`, overlay system (`OverlayOptions`, `OverlayHandle`), differential rendering (composite overlays, then line-diff against previous frame).
- `terminal.ts` — `interface Terminal` + `ProcessTerminal` (raw mode, keyboard protocol negotiation incl. Kitty protocol, Apple Terminal quirks).
- `editor-component.ts` + `editor.ts` — full text editor (undo stack, kill ring, word navigation, autocomplete); `autocomplete.ts`, `fuzzy.ts`, `keybindings.ts`, `keys.ts`.
- `components/` — `box`, `text`, `truncated-text`, `markdown`, `input`, `select-list`, `settings-list`, `loader`, `cancellable-loader`, `image`, `spacer`.
- `terminal-image.ts` (inline images), `terminal-colors.ts`, `syntax highlighting` is in coding-agent (`utils/syntax-highlight.ts`, highlight.js).
- `native/` — `darwin/`, `win32/` native helpers.

### Coding agent (`packages/coding-agent/src/`)

- `cli.ts`, `main.ts`, `cli/args.ts` — CLI entry (`bin: pi → dist/cli.js`), arg parsing, startup UI, session picker, config selector, `project-trust.ts`.
- `modes/` — four run modes: `interactive/interactive-mode.ts` (TUI), `print-mode.ts` (`-p`), json mode, `rpc/rpc-mode.ts` (`--mode rpc`).
- `core/agent-session.ts` (3322 lines) — `class AgentSession`: binds `Agent` + `SessionManager` + `SettingsManager` + `ResourceLoader` + `ExtensionRunner`; owns auto-compaction, overflow recovery, auto-retry, branch summarization, bash execution state, tool registry (`_toolRegistry`, `_toolDefinitions`, prompt snippets/guidelines), model cycling, system-prompt assembly.
- `core/agent-session-runtime.ts` / `agent-session-services.ts` — session replacement/switch orchestration (`AgentSessionRuntime`, `createAgentSessionRuntime`, `createAgentSessionServices`, `createAgentSessionFromServices`).
- `core/sdk.ts` — `createAgentSession(options)` programmatic entry (see §3).
- `core/session-manager.ts` (1712 lines) — JSONL session format v3 + `class SessionManager` (see §3).
- `core/extensions/` — `types.ts` (1689 lines: full extension API), `loader.ts` (jiti-based TS loading), `runner.ts` (`ExtensionRunner`, event dispatch, error isolation), `wrapper.ts` (hook wrapper around tool execution).
- `core/settings-manager.ts` — `Settings` schema, `SettingsManager`, global/project merge (`deepMergeSettings`), file locking via `proper-lockfile`.
- `core/resource-loader.ts` — `DefaultResourceLoader`: discovers extensions/skills/prompts/themes/AGENTS.md context files from global, project, packages, CLI, settings; supports override hooks for every resource type.
- `core/package-manager.ts` (2650 lines) — npm/git package install/update/remove for pi packages.
- `core/model-registry.ts`, `model-runtime.ts`, `model-resolver.ts`, `models-store.ts`, `remote-catalog-provider.ts`, `auth-storage.ts` — model/auth runtime.
- `core/compaction/` — coding-agent-side compaction & branch summarization (thresholds, retry, overflow recovery).
- `core/tools/` — `bash`, `read`, `edit`, `write`, `grep`, `find`, `ls` with TUI renderers (`render-utils.ts`), truncation, output accumulator, file mutation queue.
- `core/exec.ts`, `bash-executor.ts` — user `!`/`!!` bash execution.
- `core/export-html/` — self-contained HTML session export (template + vendored JS).
- `modes/interactive/components/` — 40+ TUI components: `tool-execution.ts`, `assistant-message.ts`, `footer.ts`, `custom-editor.ts`, selectors (model, theme, session, settings, tree, login/oauth), `extension-editor/input/selector.ts`.
- `modes/interactive/theme/` — `theme.ts`, `theme-schema.json`, built-in `dark.json`/`light.json`, `theme-controller.ts`.
- `rpc-entry.ts` — separate bin entry for RPC mode.
- `config.ts` — install-method detection (`detectInstallMethod`: bun-binary/npm/pnpm/yarn/bun), self-update command construction, all path getters (`getAgentDir` = `~/.pi/agent`, `getSessionsDir`, `getModelsPath`, `getAuthPath`, `getSettingsPath`, …), `piConfig` package.json key support for rebranding (`APP_NAME`, `CONFIG_DIR_NAME`).

## 3. Exact API surfaces

### 3.1 Agent loop config — `AgentLoopConfig` (`packages/agent/src/types.ts:144`)

```ts
interface AgentLoopConfig extends SimpleStreamOptions {
  model: Model<any>;
  convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
  transformContext?: (messages: AgentMessage[], signal?) => Promise<AgentMessage[]>;
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  shouldStopAfterTurn?: (ctx: ShouldStopAfterTurnContext) => boolean | Promise<boolean>;
  prepareNextTurn?: (ctx: PrepareNextTurnContext) => AgentLoopTurnUpdate | undefined | Promise<...>;
  getSteeringMessages?: () => Promise<AgentMessage[]>;
  getFollowUpMessages?: () => Promise<AgentMessage[]>;
  toolExecution?: "sequential" | "parallel"; // default parallel
  beforeToolCall?: (ctx: BeforeToolCallContext, signal?) => Promise<{block?: boolean; reason?: string} | undefined>;
  afterToolCall?: (ctx: AfterToolCallContext, signal?) => Promise<AfterToolCallResult | undefined>;
}
```

Events (`AgentEvent`, `types.ts:422`): `agent_start`, `agent_end{messages}`, `turn_start`, `turn_end{message, toolResults}`, `message_start/update/end`, `tool_execution_start/update/end`.

### 3.2 Tool interface — `AgentTool` (`packages/agent/src/types.ts:380`)

```ts
interface AgentTool<TParameters extends TSchema = TSchema, TDetails = any> extends Tool<TParameters> {
  label: string;
  prepareArguments?: (args: unknown) => Static<TParameters>;
  execute(toolCallId, params: Static<TParameters>, signal?, onUpdate?: AgentToolUpdateCallback<TDetails>)
    => Promise<AgentToolResult<TDetails>>;   // throw on failure
  executionMode?: "sequential" | "parallel";
}
interface AgentToolResult<T> {
  content: (TextContent | ImageContent)[];
  details: T;
  usage?: Usage;
  addedToolNames?: string[];   // tools can introduce new tools mid-run
  terminate?: boolean;         // batch stops when ALL results set terminate
}
```

Parameters are **TypeBox** schemas (`typebox` dependency); validation via `validateToolArguments` from pi-ai.

### 3.3 Coding-agent ToolDefinition — `packages/coding-agent/src/core/extensions/types.ts:442`

Adds to `AgentTool`: `description`, `promptSnippet?`, `promptGuidelines?` (injected into default system prompt), `renderShell?: "default"|"self"`, and TUI renderers `renderCall?(args, theme, ToolRenderContext) => Component`, `renderResult?(result, {expanded, isPartial}, theme, ctx) => Component`. `execute` receives a 5th arg `ctx: ExtensionContext`. Helper: `defineTool()` for type inference.

### 3.4 Extension API — `ExtensionAPI` (`core/extensions/types.ts:1174`)

Extensions are TypeScript modules, default-exporting `ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>`, loaded via **jiti** (`core/extensions/loader.ts`). Discovery: `~/.pi/agent/extensions/`, `.pi/extensions/` (project, trust-gated), packages, `settings.extensions[]`, `--extension/-e` CLI flag (also accepts `npm:`/`git:` sources into a temp dir), inline factories via SDK.

- `pi.on(event, handler)` — ~30 events with typed results: `session_start/before_switch/before_fork/before_compact/compact/before_tree/tree/shutdown/info_changed`, `context` (rewrite message list per LLM call), `before_provider_request` (replace payload), `before_provider_headers` (mutate headers), `after_provider_response`, `before_agent_start` (replace system prompt / inject custom message), `agent_start/end/settled`, `turn_start/end`, `message_start/update/end`, `tool_execution_start/update/end`, `tool_call` (block or mutate `event.input`), `tool_result` (rewrite content/details/isError), `input` (continue/transform/handled), `user_bash`, `model_select`, `thinking_level_select`, `project_trust`, `resources_discover` (contribute skill/prompt/theme paths).
- Registration: `registerTool()`, `registerCommand()`, `registerShortcut()`, `registerFlag()`/`getFlag()`, `registerMessageRenderer(customType, fn)`, `registerEntryRenderer(customType, fn)`, `registerProvider(name, ProviderConfig)` / `registerProvider(Provider)` / `unregisterProvider()`.
- Actions: `sendMessage()` (custom messages, deliverAs steer/followUp/nextTurn), `sendUserMessage()`, `appendEntry(customType, data)` (session-persisted state), `setSessionName`/`getSessionName`, `setLabel`, `exec()`, `getActiveTools`/`setActiveTools`/`getAllTools`, `getCommands`, `setModel`, `get/setThinkingLevel`, `events: EventBus` (shared bus).
- `ExtensionContext` (handler ctx): `ui: ExtensionUIContext` (select/confirm/input/notify/custom components/widgets/footer/header/editor replacement/themes/status/working indicator), `mode` (`"tui"|"rpc"|"json"|"print"`), `hasUI`, `sessionManager` (read-only), `modelRegistry`, `model`, `isIdle()`, `abort()`, `compact()`, `getContextUsage()`, `getSystemPrompt()`, `shutdown()`, `isProjectTrusted()`.
- `ExtensionCommandContext` adds `waitForIdle()`, `newSession()`, `fork(entryId)`, `navigateTree()`, `switchSession(path)`, `reload()`.

### 3.5 Provider registration — `ProviderConfig` (`core/extensions/types.ts:1416`)

```ts
pi.registerProvider("my-proxy", {
  baseUrl, apiKey: "$ENV_VAR" | "!command" | literal, api: "anthropic-messages" | ...,
  headers?, authHeader?, models: ProviderModelConfig[],
  refreshModels?(ctx) => Promise<ProviderModelConfig[]>,
  streamSimple?: (model, context, options?) => AssistantMessageEventStream,  // custom wire protocol
  oauth?: { name, login(callbacks), refreshToken(creds), getApiKey(creds), modifyModels? },
});
```

Native path: `pi.registerProvider(provider: Provider)` with pi-ai's `ProviderStreams`. Models can also be user-defined in `~/.pi/agent/models.json`; OAuth credentials in `~/.pi/agent/auth.json`.

### 3.6 Session format (on disk)

JSONL, one JSON object per line. Location: `~/.pi/agent/sessions/--<cwd-with-dashes>--/<timestamp>_<uuid>.jsonl` (override via `ENV_SESSION_DIR` / `sessionDir` setting). First line is `SessionHeader`:

```ts
{ type: "session", version: 3, id: string /* uuidv7 */, timestamp, cwd, parentSession? }
```

Then `SessionEntry` lines forming a **tree** via `id` (8-hex, collision-checked) + `parentId` (`core/session-manager.ts:30-156`):

- `message` — `{ message: AgentMessage }`
- `thinking_level_change` — `{ thinkingLevel }`
- `model_change` — `{ provider, modelId }`
- `compaction` — `{ summary, firstKeptEntryId, tokensBefore, details?, usage?, fromHook? }`
- `branch_summary` — `{ fromId, summary, details?, usage?, fromHook? }`
- `custom` — `{ customType, data? }` — extension state, excluded from LLM context
- `custom_message` — `{ customType, content, display, details? }` — injected into LLM context as user message
- `label` — `{ targetId, label }` (bookmarks)
- `session_info` — `{ name }`

`buildSessionContext()` (`session-manager.ts:461`) walks the current branch, finds the latest compaction entry, and reconstructs context as summary + entries after `firstKeptEntryId`. Version migrations v1→v3 in `migrateSessionEntries()` / `packages/coding-agent/src/migrations.ts`. The agent-core harness mirrors this with a pluggable `SessionStorage` interface (`packages/agent/src/harness/types.ts:498`) and JSONL/memory/sqlite backends.

### 3.7 RPC protocol (`core/../modes/rpc/rpc-types.ts`)

JSON-lines over stdin/stdout (`pi --mode rpc`). Commands have optional `id`; responses are `{ id, type: "response", command, success, data|error }`. Commands: `prompt`, `steer`, `follow_up`, `abort`, `new_session`, `get_state`, `set_model`, `cycle_model`, `get_available_models`, `set_thinking_level`, `cycle_thinking_level`, `set_steering_mode`, `set_follow_up_mode`, `compact`, `set_auto_compaction`, `set_auto_retry`, `abort_retry`, `bash`, `abort_bash`, `get_session_stats`, `export_html`, `switch_session`, `fork`, `clone`, `get_fork_messages`, `get_entries`, `get_tree`, `get_last_assistant_text`, `set_session_name`, `get_messages`, `get_commands`. Agent events stream out as JSON lines; extension UI interactions are bridged via `extension_ui_request` (stdout) / `extension_ui_response` (stdin). Client helper: `modes/rpc/rpc-client.ts`.

### 3.8 SDK (`core/sdk.ts`)

```ts
const { session, extensionsResult, modelFallbackMessage } = await createAgentSession({
  cwd?, agentDir?,                    // default ~/.pi/agent
  modelRuntime?, model?, thinkingLevel?, scopedModels?,
  noTools?: "all"|"builtin", tools?: string[], excludeTools?: string[],
  customTools?: ToolDefinition[],
  resourceLoader?, sessionManager?, settingsManager?, sessionStartEvent?,
});
```

Re-exports tool factories `createCodingTools`, `createReadOnlyTools`, `createReadTool`, `createBashTool`, `createEditTool`, `createWriteTool`, `createGrepTool`, `createFindTool`, `createLsTool`, `withFileMutationQueue`, plus `AgentSessionRuntime` helpers and OAuth/model utilities (`getAvailableModels`, `login`, `logout`, …). Default active tools: `["read", "bash", "edit", "write"]` (grep/find/ls also registered).

### 3.9 Configuration files & precedence

| File | Scope |
|---|---|
| `~/.pi/agent/settings.json` | global settings |
| `.pi/settings.json` | project settings (wins; deep-merged, nested objects merge, arrays/primitives override) — only loaded when project is **trusted** |
| `~/.pi/agent/auth.json` | OAuth credentials + API keys |
| `~/.pi/agent/models.json` | custom providers/models |
| `~/.pi/agent/trust.json` | saved project-trust decisions |
| `~/.pi/agent/{extensions,skills,prompts,themes}/` | global resources |
| `.pi/{extensions,skills,prompts,themes,settings.json}` | project resources (trust-gated) |
| `~/.agents/skills/`, `.agents/skills/` (cwd + ancestors to git root) | cross-harness skills (agentskills.io standard) |
| `AGENTS.md` / `CLAUDE.md` | context files: agentDir global + every ancestor of cwd, concatenated root→leaf |
| env: `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`, `PI_PACKAGE_DIR` | path overrides (prefix derived from `piConfig.name`) |

`package.json` `piConfig: { name, configDir }` allows full rebrand (app name, `.pi` dir name, env var names) — already used (`"configDir": ".pi"`).

### 3.10 Skills / prompt templates / themes / packages

- **Skills:** agentskills.io standard. `Skill { name, description, content, filePath, disableModelInvocation? }`. Discovery: `~/.pi/agent/skills/`, `~/.agents/skills/`, `.pi/skills/`, `.agents/skills/` (ancestors), packages, settings, `--skill`. Directories with `SKILL.md` found recursively; root `.md` files count in pi dirs. Injected into system prompt as XML block (`formatSkillsForSystemPrompt`); invocable as `/skill:name` commands.
- **Prompt templates:** `*.md` files, non-recursive; `/name` expands template into prompt. Locations mirror skills (`prompts/`).
- **Themes:** JSON files matching `modes/interactive/theme/theme-schema.json`; built-in `dark`/`light`; `~/.pi/agent/themes/*.json`, `.pi/themes/*.json`, packages, settings, `--theme`.
- **Packages:** npm (`npm:@foo/bar@1.0.0`), git (`git:github.com/user/repo@v1`), URLs, local paths. Declare resources under `package.json` `pi` key (`pi.extensions`, `pi.skills`, `pi.prompts`, `pi.themes`) or conventional dirs. Managed via `pi install/remove/list/update`; stored in settings `packages[]` with per-resource filtering (`PackageSource`). Project packages auto-install on startup after trust.

### 3.11 Compaction, checkpoints, subagents

- **Compaction:** triggers when `contextTokens > contextWindow - reserveTokens` (default reserve 16384). Walks back accumulating estimates to `keepRecentTokens` (default 20k) cut point, LLM-summarizes with structured format (previous summary fed iteratively), appends `CompactionEntry` with `firstKeptEntryId`. Manual `/compact [instructions]`. Overflow recovery: on context-overflow error, compact and retry aborted turn once. Extensions can cancel or fully replace via `session_before_compact` (`SessionBeforeCompactResult { cancel?, compaction? }`).
- **Branch summarization:** on `/tree` navigation, summarizes abandoned branch into `BranchSummaryEntry` so switching back restores context.
- **Checkpoints:** **not built in**. `examples/extensions/git-checkpoint.ts` implements git-stash checkpoints at each `turn_start` and restores on `session_before_fork` — the intended pattern.
- **Subagents:** **not present** in this codebase (no subagent/task tool anywhere in `packages/*/src`). Would be built as a custom tool spawning a nested `Agent`/`AgentSession`.

### 3.12 Permissions / exec approval / sandbox

- **No built-in permission system.** Pi runs with the launching user's permissions; README states this explicitly. Gates that exist:
  - **Project trust** (`core/project-trust.ts`, `trust-manager.ts`): interactive prompt before loading `.pi/` resources/settings or installing project packages; `defaultProjectTrust: "ask"|"always"|"never"`; `--approve/-a`, `--no-approve/-na`; `/trust` persists to `trust.json`. Extensions can implement the prompt via `project_trust` event.
  - **Extension-based approval**: `tool_call` event with `{block, reason}` is the sanctioned seam; `examples/extensions/confirm-destructive.ts` demonstrates confirmation gates.
- **Sandboxing:** delegated to containerization — `docs/containerization.md`: Gondolin extension (micro-VM, `examples/extensions/gondolin`), plain Docker, OpenShell. `examples/extensions/sandbox` also exists. The agent-core `ExecutionEnv`/`FileSystem`/`Shell` interfaces (`packages/agent/src/harness/types.ts`) are the designed seam for routing tool I/O into a sandbox.

## 4. Reusable as-is vs. reimplement

**Reusable as-is (MIT, published npm packages):**

- `@earendil-works/pi-ai` — full multi-provider layer (10 wire protocols, OAuth, model catalog, cost tracking). Drop-in.
- `@earendil-works/pi-agent-core` — agent loop + `Agent` + harness (session tree, compaction, ExecutionEnv, portable tool impls). Drop-in; provider-agnostic.
- `@earendil-works/pi-tui` — differential-rendering TUI toolkit. Drop-in, framework-free.
- `@earendil-works/pi-coding-agent` SDK (`createAgentSession`, tool factories, `SessionManager`, `SettingsManager`, `DefaultResourceLoader`, `ExtensionRunner`) — the whole harness can be embedded and rebranded (`piConfig`).
- Session JSONL format — readable/writable directly; stable at v3 with migrations.

**Must reimplement (or accept as-is):**

- **Permission/approval system** — none exists; only project trust + extension hooks. Any enforced exec-approval policy is our code (via `tool_call` hooks or a wrapped `ExecutionEnv`).
- **Subagent orchestration** — no upstream concept; build as custom tool(s) over `Agent`.
- **Checkpoints** — extension example only (~50 lines, git-stash based).
- **Custom UI shell** — if OmniHarness wants its own TUI identity, it's a new mode or a fork of `interactive-mode.ts` (large, 40+ components); the `ExtensionUIContext` (setFooter/setHeader/setEditorComponent/widgets) covers substantial restyling without forking.
- **Server/multi-client** — `pi-server` is experimental; don't build on it.

## 5. Extension strategy: can we extend without forking?

**Yes — the codebase is designed for it, with three escalating seams:**

1. **Extensions (no fork, runtime):** TypeScript modules via `~/.pi/agent/extensions/`, project `.pi/extensions/`, `pi -e`, or installable npm/git **pi packages**. Can register tools/providers/commands/shortcuts/flags, intercept every lifecycle event, block/rewrite tool calls, replace system prompt per turn, customize compaction, replace footer/header/editor, add widgets/overlays, persist state in session `custom` entries. 79 example extensions ship in `packages/coding-agent/examples/extensions/`.
2. **SDK embedding (no fork, build time):** `createAgentSession()` + `DefaultResourceLoader` override hooks (`extensionsOverride`, `skillsOverride`, `promptsOverride`, `themesOverride`, `agentsFilesOverride`, `systemPromptOverride`) + `customTools` + `baseToolsOverride` + inline `extensionFactories` + custom `ExecutionEnv`/stream functions. Modes other than interactive are small; RPC mode gives a full headless JSONL protocol for a foreign UI.
3. **Rebrand (no fork, config):** `piConfig` in package.json changes app name, config dir, env var prefixes.

Specific seams worth exploiting for OmniHarness: `tool_call`/`beforeToolCall` for permissions; `ExecutionEnv` for sandboxing; `registerProvider` + `models.json` for model routing; `context` event for context-window policy; `session_before_compact` for custom memory; `appendEntry`/`custom_message` entries for OmniHarness-specific session metadata; RPC mode for a non-terminal front end.

Forking should only be needed for: deep changes to interactive-mode chrome beyond `ExtensionUIContext`, changes to the core event vocabulary, or divergent session format. Even then, prefer depending on `pi-agent-core` + `pi-ai` + `pi-tui` and writing our own coding-agent layer on top (the layering is clean: coding-agent is "just" the biggest consumer of agent-core).

## 6. Risks

- **License:** MIT — no copyleft risk. Copyright Mario Zechner; keep `LICENSE` attribution in any vendored copy. Vendored export-html JS and pinned deps carry their own licenses (check shrinkwrap if redistributing binaries).
- **Upstream stability/rename churn:** project moved `badlogic/pi-mono` → `earendil-works/pi` (npm scope `@mariozechner/*` → `@earendil-works/*`) and docs still reference the old name; URLs/imports have changed at least once. Fast-moving (0.81.1, near-daily commits; v0.35 broke settings shape, v0.81 changed `Agent` construction). Pin exact versions; track CHANGELOGs per package.
- **Single-maintainer risk:** effectively one author; review/load-bearing decisions can change quickly. New-contributor PRs are auto-closed — upstream contribution channel is limited, so a hard fork is costly to merge back.
- **Coupling:** coding-agent ↔ agent-core ↔ ai are released in lockstep with `^0.81.1` internal ranges — partial upgrades are unsafe. Extension API is rich but not semver-frozen; events/contexts gained breaking renames before (hooks→extensions migration).
- **Security surface:** extensions and skills run with full user privileges by design; project trust is the only gate and defaults to "ask" only in interactive mode (non-interactive falls back to `defaultProjectTrust`). Supply-chain hardening exists upstream (pinned deps, shrinkwrap, `--ignore-scripts`, npm audit CI) — inherit those practices, and note `enableInstallTelemetry` defaults to true (phones `https://pi.dev/api/report-install`).
- **Experimental surfaces:** `pi-server`, `packages/storage/sqlite-node`, and `PI_EXPERIMENTAL=1` paths are explicitly unstable.
