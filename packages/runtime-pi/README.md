# @omniharness/runtime-pi

Agent runtime adapter that makes [Pi](https://github.com/earendil-works/pi)
(`@earendil-works/pi-agent-core` + `@earendil-works/pi-ai`, pinned 0.81.1) the
single agent kernel for OmniHarness. Pi owns the agent loop (turn management,
steering/follow-up queues, tool-call orchestration, stream protocol); every
side effect stays inside OmniHarness packages:

- **Models** go through `@omniharness/model-gateway` (`ModelRouter`) — role
  routing, fallbacks, retries, budgets and usage recording keep working. Pi
  never talks to a provider.
- **Tools** come from `@omniharness/tool-runtime` (`ToolRegistry` +
  `ToolRuntime`) — validation → policy → approval → sandbox → sanitize →
  audit on every call.
- **Persistence** is delegated to the daemon via the injected `RunRecorder`
  hook (implemented over `@omniharness/session-store`). This package is
  storage-free.
- **Skills/memory** are delegated to the daemon via the injected
  `buildContext(sessionId)` hook, which returns extra system-prompt sections
  (memory block, skill bodies, AGENTS.md content). The runtime itself knows
  nothing about memory or skills.

## API

```ts
const runtime = new PiAgentRuntime({
  router,          // ModelRouter (model-gateway)
  registry,        // ToolRegistry (tool-runtime)
  policy,          // PolicyEvaluator (policy-engine)
  approvalGate,    // optional ApprovalGate for ask_* decisions
  workspace,       // Workspace all tool executions are scoped to
  systemPrompt,    // optional base system prompt
  buildContext,    // optional (sessionId) => string[] extra prompt sections
  recorder,        // optional RunRecorder persistence hook
  compaction,      // optional CompactionSettings overrides, or false
});

const events = runtime.startRun({ sessionId, input: "fix the bug" });
for await (const event of events) { /* RuntimeEvent */ }

runtime.steer(runId, "also update the tests");   // inject mid-run
runtime.enqueueFollowUp(runId, "then summarize"); // run after agent stops
runtime.interrupt(runId);                         // abort cleanly
```

`RuntimeEvent` mirrors the run/message/tool shapes of
`@omniharness/agent-protocol` (`run.started/completed/failed/compacting/
compacted/steered`, `message.started/delta/completed/attachment`,
`tool.call.started/output/completed/failed/denied`) without `seq`/`at` — the
daemon stamps those when persisting to its event log. `message.delta` carries
`channel: "text" | "reasoning"`.

One Pi `Agent` (and therefore one transcript) is kept per session; one active
run per session. The first event of every run is `run.started`; the last is
`run.completed` (with accumulated usage) or `run.failed`.

## Architecture

| Piece | File | Seam used |
|---|---|---|
| Model bridge | `src/model-bridge.ts` | Pi's `StreamFn` (`(model, context, options) => AssistantMessageEventStream`). Translates Pi `Context` ↔ gateway `ChatMessage[]`/`ToolSpec[]`, folds gateway `ModelStreamChunk`s into Pi's assistant-message event protocol (text/thinking/toolcall/done/error), maps usage and stop reasons both ways. Never throws — failures become `stopReason: "error" \| "aborted"` per Pi's contract. The `Model<Api>` given to Pi is synthetic metadata (`toPiModel`). |
| Tool bridge | `src/tool-bridge.ts` | Converts each `ToolRegistry` entry into a Pi `AgentTool`. Our plain-JSON-Schema `parametersSchema` is passed through as-is — pi-ai's `validateToolArguments` supports non-TypeBox schemas (verified). Execution goes through `ToolRuntime.run`; `ToolOutputChunk`s stream out as `tool.call.output`. |
| Compaction | `src/compaction.ts` | Pi `transformContext` hook + pi-agent-core's `estimateContextTokens`/`estimateTokens`/`shouldCompact`/`serializeConversation` helpers. Summarization runs through the router's **summarizer** role. |
| Runtime | `src/runtime.ts` | `Agent` per session, `RuntimeEvent` queue per run, steering/follow-up/interrupt, recorder + buildContext hooks. |

## Deliberate deviations from upstream Pi

- **Own compaction instead of harness `prepareCompaction`/`compact`.** Pi's
  full pipeline operates on harness session-tree entries (`SessionStorage`),
  which belongs to Pi's own persistence layer. OmniHarness persistence lives
  in the daemon (session-store), so the adapter uses threshold compaction in
  context: when estimated tokens exceed `contextWindow - reserveTokens`
  (defaults: 16384 reserve, 20000 kept-recent), the oldest messages are
  summarized via the summarizer role and replaced by a summary user message;
  the cut never splits a tool-call/tool-result group. The compacted
  transcript is persisted back into the agent state at run end.
  `run.compacting`/`run.compacted` events are emitted. Compaction failure is
  non-fatal (the run proceeds uncompacted).
- **Denial classification by message prefix.** `ToolRuntime` is deliberately
  exception-free and encodes policy/approval denials in the result text
  (`Policy denied …`, `Approval denied for …`). The tool bridge classifies on
  these prefixes to choose between `tool.call.denied` and `tool.call.failed`.
- **Pre-aborted tool calls are short-circuited in the bridge.** `ToolRuntime`
  cannot handle a signal that is already aborted at entry (its abort/timeout
  listeners never fire on a pre-aborted controller and the run would hang
  until the default timeout); the bridge throws `Tool execution aborted`
  immediately instead, matching Pi's own "Operation aborted" fast path.
- **Images/vision are placeholders.** The gateway `ChatMessage` model has no
  image part, so Pi `ImageContent` becomes an `[image omitted: mimeType]`
  text marker and `startRun` attachments become `message.attachment` events
  plus a text reference. Extend model-gateway when vision lands.
- **Summarizer-usage accounting.** Usage from compaction summarizer calls is
  recorded by the router's `UsageRecorder` (budgets see it) but is not folded
  into `run.completed.usage`, which reflects primary-loop turns only.

## Tests

`src/runtime.test.ts` (vitest, model-gateway `FixtureProvider`): plain text
reply with usage, `fs.write` executed through the full ToolRuntime pipeline,
policy denial of `shell.exec` → `tool.call.denied`, mid-run steering,
interrupt, and threshold compaction through the summarizer role.

```sh
pnpm --filter @omniharness/runtime-pi build
pnpm --filter @omniharness/runtime-pi test
```
