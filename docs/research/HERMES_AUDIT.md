# Hermes Agent — Source-Level Audit (Memory & Skill Learning)

Audit date: 2026-07-23. Audited from a shallow clone at `tmp/upstream/hermes-agent` (gitignored, not committed).

## 1. Identity & version audited

- **Repo:** https://github.com/NousResearch/hermes-agent (exists; ~216k stars, very actively developed)
- **Commit:** `7168845dc314e2621a64e616a9d5485668c366c1` (main, 2026-07-23)
- **Version:** `0.19.0` (`pyproject.toml`; `hermes_cli/__init__.py` `__version__`, `__release_date__ = "2026.7.20"`). Releases use **CalVer** tags via `scripts/release.py`.
- **License:** **MIT**, "Copyright (c) 2025 Nous Research" (`LICENSE`). No top-level NOTICE file. Per-plugin licenses exist at `plugins/security-guidance/{LICENSE,NOTICE}` and `plugins/hermes-achievements/LICENSE`. `native/fts5_cjk/vendor/sqlite3*.h` is public-domain SQLite headers. `agent/redact.py` credits ported patterns from `nearai/ironclaw#2529`.
- **Language/stack:** Python 3.11–3.13 (`requires-python >=3.11,<3.14`), ~69 exact-pinned deps (deliberate supply-chain policy; version ranges banned after the "Mini Shai-Hulud" worm). JS side (`ui-tui/`, `web/`, `apps/`) is an Ink/React TUI and web dashboard, versioned independently.
- **Known CVEs:** none listed in `SECURITY.md`. Pin annotations reference CVE-2026-25645 (`requests==2.33.0`) and CVE-2026-34450/34452 (`anthropic==0.87.0`). A third-party advisory (CVE-2026-10223) alleges a `memory_tool.py` injection issue in versions ≤2026.4.30; not acknowledged in-repo.
- **Trust model (SECURITY.md):** single-tenant; the terminal backend is the one load-bearing security boundary; prompt-injection/heuristic limits explicitly out of scope.

## 2. Architecture map

Entry points: `cli.py` (interactive REPL, ~16k lines), `run_agent.py` (`class AIAgent` at `run_agent.py:400`, `main()` one-shot), `hermes_cli/main.py` (the installed `hermes` command, subcommands under `hermes_cli/subcommands/`).

```
run_agent.py / cli.py / hermes_cli/        ← entry points
agent/conversation_loop.py                 ← THE AGENT LOOP (6,065 lines; run_conversation() at :668) — DO NOT REUSE
agent/tool_executor.py                     ← tool-call dispatch (concurrent/sequential/segmented)
agent/agent_init.py                        ← AIAgent.__init__ body (provider/credential/context bootstrap)
agent/system_prompt.py + prompt_builder.py ← 3-tier system prompt (stable/context/volatile)
tools/registry.py + toolsets.py            ← tool registration & toolset bundles
├── tools/memory_tool.py                   ← built-in curated memory (MEMORY.md / USER.md)
├── agent/memory_manager.py + memory_provider.py  ← external memory provider fan-out (ABC MemoryProvider)
├── plugins/memory/{honcho,mem0,holographic,...}  ← pluggable memory backends
├── tools/skills_tool.py                   ← skill discovery/view (progressive disclosure)
├── tools/skill_manager_tool.py            ← skill create/patch/edit/delete + guards
├── agent/background_review.py             ← self-improvement fork (memory + skill nudges)
├── agent/curator.py + curator_backup.py   ← idle-triggered skill lifecycle maintenance
├── tools/skill_usage.py                   ← .usage.json telemetry sidecar
├── tools/skills_hub.py + skills_sync.py   ← hub install/provenance + bundled-skill sync
├── tools/skills_guard.py + skills_ast_audit.py + threat_patterns.py  ← security scanning
├── hermes_state.py                        ← SQLite state.db: sessions/messages/FTS5/gateway routing
├── tools/session_search_tool.py           ← FTS5/BM25 cross-session recall
├── tools/checkpoint_manager.py            ← filesystem snapshots (shadow git) — NOT conversation state
├── tools/write_approval.py                ← staged write-approval gate (memory + skills)
├── agent/credential_*.py + secret_sources/← auth.json, credential pool, external secret managers
gateway/                                   ← Telegram/Discord/Slack/WhatsApp/Signal session routing
cron/                                      ← scheduler (jobs.json + executions.db)
```

State root: `HERMES_HOME` (`hermes_constants.get_hermes_home()`, default `~/.hermes`, profile-scoped under `profiles/<name>/`).

## 3. Memory subsystem — schema & retrieval

### 3.1 What actually exists vs. the marketing taxonomy

| Claimed | Reality in code |
|---|---|
| Semantic memory | Two flat text files, `~/.hermes/memories/MEMORY.md` + `USER.md`, injected **whole** into the system prompt (`tools/memory_tool.py`) |
| Episodic memory | SQLite `~/.hermes/state.db` (sessions/messages + FTS5), recalled on demand via the `session_search` tool — no automatic injection |
| Procedural memory | The **skills** subsystem (`~/.hermes/skills/`); the memory tool schema itself says "Reusable procedures belong in a skill, not memory" (`tools/memory_tool.py:1096`) |
| User model | Built-in: `USER.md`. External: Honcho plugin (peers/representations/cards/conclusions, data server-side) |
| Vector/embeddings | **None in built-in memory.** Only the holographic plugin (HRR vectors, local SQLite) and Honcho (remote) do anything vector-like |

### 3.2 Built-in memory storage format (importer-critical)

- Paths from `get_memory_dir()` / `_path_for()` (`tools/memory_tool.py:55-57,291`).
- **Format: raw text, entries joined by `ENTRY_DELIMITER = "\n§\n"`** (`:69`). No frontmatter, no IDs, no timestamps, no per-entry metadata. Entries may be multiline.
- Parse: `raw.split(ENTRY_DELIMITER)` + strip + drop empties (`_read_file`, `:693`). Write: join + temp-file + `atomic_replace` (`_write_file`, `:770`), `fcntl.flock` sidecar `.lock` files (`:255`).
- Budgets are **chars**: memory 2200, user 1375; config `memory.memory_char_limit` / `memory.user_char_limit` (`load_on_disk_store()`, `:801`).
- External edits are tolerated only if the file round-trips as a clean §-list with no entry over the limit; otherwise `_detect_external_drift()` writes `MEMORY.md.bak.<unix_ts>` (`:714`).
- Dedup: order-preserving exact-dup removal on load (`list(dict.fromkeys(...))`, `:202,315`) and exact-dup rejection on `add` (`:370`). **No semantic dedup, no decay, no auto-compaction.**

Example file:

```
User's project is a Rust web service at ~/code/myapi using Axum + SQLx
§
This machine runs Ubuntu 22.04, has Docker and Podman installed
```

### 3.3 Built-in retrieval: there is none

- Entire content injected as a **frozen snapshot** at `load_from_disk()` (`:178`); mid-session writes never change the prompt (prefix-cache preservation). Injection site `agent/system_prompt.py:483-501` (volatile tier), gated by config `memory.memory_enabled` / `memory.user_profile_enabled` (**both default false**).
- Block format (`_render_block`, `:674`): a `═══` header with fill percentage, then §-joined entries. Headers exported as `MEMORY_BLOCK_HEADERS`.
- Pre-snapshot, each entry is scanned with `tools.threat_patterns.scan_for_threats(scope="strict")`; hits are replaced in the snapshot with `[BLOCKED: ...]` while disk keeps raw text (`_sanitize_entries_for_snapshot`, `:218`).
- Consolidation is **model-driven**: an over-budget write returns an error embedding `current_entries` and the model must consolidate same-turn via atomic batch `operations` (`apply_batch`, `:507`); circuit breaker `_MAX_CONSOLIDATION_FAILURES_PER_TURN = 3` (`:138`).

### 3.4 Tool schema exposed to the LLM

`memory` tool (`MEMORY_SCHEMA`, `tools/memory_tool.py:1074`): `target: "memory"|"user"` (required); single-op `action: "add"|"replace"|"remove"` with `content` / `old_text` (unique substring); or batch `operations: [...]` (atomic, all-or-nothing). No read action — content is already in the prompt.

### 3.5 Memory nudges & background review

- `_memory_nudge_interval` default **10 turns** (config `memory.nudge_interval`). Counter in `agent/turn_context.py:552-558`; fires in `agent/turn_finalizer.py:593-597` → `_spawn_background_review` (`run_agent.py:1643`) → `agent/background_review.py`.
- The review forks a quiet `AIAgent` (`quiet_mode`, `_persist_disabled`, `compression_enabled=False`, tool whitelist = memory+skills only) that replays the conversation (full replay on same model for cache warmth; `_digest_history` tail=24 digest when routed to a cheaper aux model via `auxiliary.background_review.{provider,model}`) and runs `_MEMORY_REVIEW_PROMPT` / `_SKILL_REVIEW_PROMPT` / `_COMBINED_REVIEW_PROMPT` (`background_review.py:170-369`).
- Writes mirrored to external providers via `MemoryManager.notify_memory_tool_write()` with provenance metadata (`write_origin`, `execution_context`, `session_id`, `platform`).

### 3.6 Write-approval flow

`tools/write_approval.py`; config `memory.write_approval` (default **false**). `evaluate_gate(wa.MEMORY)` → allow / inline approve-deny prompt (interactive CLI) / **stage** to `~/.hermes/pending/memory/<8-hex>.json` (gateway, background review, scripts). Pending record shape (`stage_write`, `:114`):

```json
{"id": "...", "subsystem": "memory", "action": "add", "summary": "...",
 "origin": "foreground|background_review", "created_at": 0,
 "payload": {"action": "...", "target": "memory|user", "content": "...",
             "old_text": "...", "operations": [...]}}
```

User review: `/memory pending|approve <id|all>|reject <id|all>|approval on|off` (`hermes_cli/write_approval_commands.py`); replay via `apply_memory_pending(payload, store)` (`tools/memory_tool.py:1052`). Same mechanism for skills under `pending/skills/`.

### 3.7 External memory providers

- ABC `MemoryProvider` (`agent/memory_provider.py`); `MemoryManager` (`agent/memory_manager.py`) enforces **one external provider at a time** (`:394`; config `memory.provider`). Plugins: `plugins/memory/{honcho,mem0,hindsight,holographic,openviking,retaindb,byterover,supermemory}`.
- Retrieval: `prefetch_all(query)` before each turn → `build_memory_context_block()` (`:337`) wraps output in `<memory-context>` with a "NOT new user input" system note. Writes post-turn via `sync_all(user, assistant)` on a single-worker daemon executor (prefetch timeout 8s, sync drain 5s).
- **Honcho** (`plugins/memory/honcho/`): config `honcho.json`; `HonchoClientConfig` (`client.py:360`) — `workspace_id="hermes"`, `recall_mode="hybrid"`, `session_strategy="per-directory"`, `dialectic_cadence/depth/reasoning_level`. Two-layer prefetch: base context (session summary + peer `representation`/`card`) + background dialectic `peer.chat(query, reasoning_level=...)` up to depth 3 with early-bail, cadence backoff (`_BACKOFF_MAX=8`), trivial-prompt skip. Budget `context_tokens * 4` chars. Five tools: `honcho_profile/search/reasoning/context/conclude`. Migration helpers upload `MEMORY.md`/`USER.md`/`SOUL.md` as `<prior_memory_file>` wrapped files on first run (`session.py:834-931`).
- **Holographic** (`plugins/memory/holographic/`): SQLite `~/.hermes/memory_store.db`, schema (`store.py:16-76`):

```sql
CREATE TABLE facts (fact_id INTEGER PK AUTOINCREMENT, content TEXT UNIQUE,
  category TEXT DEFAULT 'general', tags TEXT DEFAULT '',
  trust_score REAL DEFAULT 0.5, retrieval_count INT DEFAULT 0,
  helpful_count INT DEFAULT 0, created_at, updated_at, hrr_vector BLOB);
CREATE TABLE entities (entity_id PK, name, entity_type, aliases, created_at);
CREATE TABLE fact_entities (fact_id, entity_id, PK(fact_id, entity_id));
CREATE VIRTUAL TABLE facts_fts USING fts5(content, tags, content=facts, content_rowid=fact_id);
CREATE TABLE memory_banks (bank_id PK, bank_name UNIQUE, vector BLOB, dim INT, fact_count, updated_at);
```

Retrieval (`retrieval.py:48`): FTS5 candidates → rerank `relevance = 0.4*fts + 0.3*jaccard + 0.3*hrr_cosine` → `score = relevance * trust_score` → optional decay `0.5^(age_days/half_life)` (off by default). Feedback: helpful +0.05 / unhelpful −0.10, clamped [0,1]. Tools `fact_store` (add/search/probe/related/reason/contradict/update/remove/list) and `fact_feedback`. This is the only built-in scored retrieval worth studying.

### 3.8 Session store (episodic) — `hermes_state.py`

SQLite `~/.hermes/state.db`, WAL mode. `SCHEMA_SQL` at `hermes_state.py:867-1036`:

- **`sessions`**: `id TEXT PK` (`YYYYMMDD_HHMMSS_<8hex>`; cron: `cron_{job_id}_{ts}`), `source` (`cli|telegram|cron|subagent|tool|...`), `user_id, session_key, chat_id, chat_type, thread_id, display_name, origin_json, model, model_config` (JSON; carries `$_branched_from`/`$_delegate_from` lineage markers), `system_prompt, parent_session_id, started_at REAL, ended_at, end_reason` (`compression|session_reset|agent_close|ws_orphan_reap|cron_complete|session_switch`), `message_count, tool_call_count, input/output/cache_read/cache_write/reasoning_tokens, cwd, git_branch, git_repo_root, billing_*, estimated_cost_usd, title, profile_name, rewind_count, archived`.
- **`messages`**: `id INTEGER PK AUTOINCREMENT, session_id FK, role, content` (multimodal parts JSON), `tool_call_id, tool_calls JSON, tool_name, timestamp REAL, token_count, reasoning, platform_message_id, observed, active INT DEFAULT 1, compacted INT DEFAULT 0, api_content` (byte-fidelity sidecar of what was sent to the API). **Ordering is always `ORDER BY id` (insertion), never timestamp** (clock-skew rationale).
- Soft-delete semantics: live `active=1`; rewind/undo `active=0, compacted=0`; compaction-archived `active=0, compacted=1` (hidden from context, still FTS-searchable).
- FTS5 external-content tables `messages_fts` (unicode61), `messages_fts_trigram` (CJK), optional `messages_fts_cjk`, with sync triggers (`FTS_SQL`, `:1057-1129`); layout versioned via `state_meta.fts_storage_version`.
- Other tables: `session_model_usage, state_meta, gateway_routing(scope, session_key, entry_json, updated_at), compression_locks, async_delegations`.
- Import API and caps: `SessionDB.create_session` / `append_message` (`:3166,5454`); built-in caps `_IMPORT_MAX_SESSIONS=500`, `_IMPORT_MAX_MESSAGES_PER_SESSION=10_000`, `_IMPORT_MAX_TOTAL_MESSAGES=50_000`, 5 MB/session, 25 MB total (`:1417-1421`).

### 3.9 Session search (`tools/session_search_tool.py`)

- **No LLM summarization** — module docstring: "No LLM calls anywhere" (the summary mode was removed; the README is stale on this point).
- BM25 `ORDER BY rank`, `snippet(..., '>>>', '<<<', '...', 40)`; default filter `active=1 OR compacted=1`.
- Four shapes inferred from args: **DISCOVERY** (`query=`, scan limit 300, demotes `source='cron'`, hides `subagent`/`tool`, dedupes by lineage root, per-hit anchored view ±5 messages + first/last-3 bookends, current-lineage hits skipped unless compression-ended), **SCROLL** (`session_id`+`around_message_id`, window 1–20), **READ** (whole session, first 20 + last 10 when large), **BROWSE** (session list). Title queries short-circuit via `resolve_session_by_title`. Cross-profile read-only via `profile=`.
- Tool schema (`SESSION_SEARCH_SCHEMA`, `:912`): `query, limit(≤10), sort, session_id, around_message_id, window(1–20), role_filter, profile`.

## 4. Skill learning loop — mechanics & data formats

### 4.1 Skill format on disk

- Root: `~/.hermes/skills/` (`tools/skills_tool.py:143` `SKILLS_DIR`); flat `<skill>/SKILL.md` and category-nested `<category>/<skill>/SKILL.md` both supported. Extra read-only roots via config `skills.external_dirs`.
- Support dirs: `references/ templates/ scripts/ assets/` (`SKILL_SUPPORT_DIRS`, `agent/skill_utils.py:27-50`).
- **Frontmatter** parsed by `agent/skill_utils.py::parse_frontmatter` (YAML SafeLoader, BOM-tolerant, naive fallback). Fields consumed: `name` (required, ≤64 chars, `^[a-z0-9][a-z0-9._-]*$`), `description` (required, ≤1024; index truncates to 60), `version, license, author, compatibility`, `platforms: [macos|linux|windows]` (hard gate), `environments: [kanban|docker|s6]` (offer-time gate), `prerequisites`, `required_environment_variables: [{name,prompt,help,...}]`, `required_credential_files`, `setup.collect_secrets`, `metadata.hermes.{tags,related_skills,category,fallback_for_toolsets,requires_toolsets,fallback_for_tools,requires_tools,config}`.
- Write validation in `tools/skill_manager_tool.py`: `MAX_SKILL_CONTENT_CHARS = 100_000`, `MAX_SKILL_FILE_BYTES = 1 MiB`, atomic writes.
- **Sidecar telemetry `~/.hermes/skills/.usage.json`** (`tools/skill_usage.py:484`):

```json
{"<skill>": {"created_by": null|"agent", "use_count": 0, "view_count": 0,
  "patch_count": 0, "last_used_at": null, "last_viewed_at": null,
  "last_patched_at": null, "created_at": "<iso>",
  "state": "active|stale|archived", "pinned": false, "archived_at": null}}
```

Counters only — **no success/failure metrics**. Skill identity is the frontmatter `name:`, not the dir name (`_read_skill_name`, `skill_usage.py:398`).
- Other sidecars: `.bundled_manifest` (`name:md5` per bundled skill), `.curator_state`, `.curator_suppressed`, `.archive/`, `.hub/lock.json` (provenance: `content_hash`, `scan_provenance{scanner_version, verdict, findings, bundle_hash, scanned_at}`), `.skills_prompt_snapshot.json` (prompt-index cache).

### 4.2 Creation loop

Two entry paths:

1. **Foreground in-context**: system prompt instructs offering to save after difficult tasks (`agent/prompt_builder.py:1742-1745`); `skill_manage` tool description lists triggers ("complex task succeeded (5+ calls), errors overcome, user-corrected approach, ...") and says "Confirm with user before creating/deleting" — a soft instruction, not a hard gate.
2. **`/learn` command**: `agent/learn_prompt.py::build_learn_prompt` embeds `_AUTHORING_STANDARDS` (house style: description ≤60 chars; `version: 0.1.0`; `author: Hermes` always — privacy rule; mandated section order: When to Use → Prerequisites → How to Run → Quick Reference → Procedure → Pitfalls → Verification). The live agent gathers context with normal tools and saves via `skill_manage(action="create", category=...)`. **No separate distillation engine.**

Only background-review-fork creations get `created_by: "agent"` (`mark_agent_created`, gated on `skill_provenance.is_background_review()`); foreground/user skills stay user-owned and are off-limits to autonomous maintenance.

### 4.3 Self-improvement loop

- Trigger: `_skill_nudge_interval` default 10 (config `skills.creation_nudge_interval`); `agent/conversation_loop.py:881-883` counts tool-calling iterations; `agent/turn_finalizer.py:576-601` spawns the fork after the response is delivered (only if `final_response and not interrupted`).
- Fork: daemon-thread `AIAgent` (`max_iterations=16`, `quiet_mode`, `skip_memory`, `_persist_disabled`, `compression_enabled=False`), inherits parent's runtime/system-prompt cache on same model; tool whitelist = skills (+memory) toolsets only; dangerous terminal commands auto-denied.
- `_SKILL_REVIEW_PROMPT` prefers, in order: (1) patch a currently-loaded skill, (2) patch an umbrella, (3) add support file, (4) create a class-level umbrella skill. Forbids editing bundled/hub/user skills and capturing env-dependent failures or one-off narratives.
- Guardrails (`tools/skill_manager_tool.py`): `_background_review_write_guard` (refuses pinned/external/protected-builtin/hub/bundled/non-agent-created), `_background_review_read_before_write_guard` (must have `skill_view`-ed the target this turn), `_curator_consolidation_delete_guard` (background deletes fail closed without `absorbed_into=<umbrella>`; archive instead of `rmtree`).
- Edits via `patch` (fuzzy match, `tools/fuzzy_match.fuzzy_find_and_replace`) or full `edit`, plus `write_file`/`remove_file` for support files.
- Approval: config `skills.write_approval` (default false) stages all writes to `pending/skills/*.json`; `/skills pending|diff|approve|reject`; replay via `apply_skill_pending`.

### 4.4 Curator (periodic lifecycle, `agent/curator.py`)

- Inactivity-triggered (not cron): `curator.enabled` (default true), `interval_hours` 168, `min_idle_hours` 2; state in `.curator_state`.
- Phase 1 deterministic: `active → stale` after `stale_after_days` 30, `→ archived` after `archive_after_days` 90, keyed off `latest_activity_at`; pinned and cron-referenced skills exempt; never deletes, only archives to `.archive/`.
- Phase 2 opt-in (`curator.consolidate`, default **false**): aux-model "umbrella-building" consolidation with structured YAML summary, per-run reports under `logs/curator/<ts>/`, pre-run tar.gz snapshot + rollback via `agent/curator_backup.py`.

### 4.5 Skill retrieval/injection

- **System-prompt index**: `agent/prompt_builder.py::build_skills_system_prompt` emits `<available_skills>` — per-category `- name: description(≤60)` lines, alphabetical (not usage-ranked), filtered by platform/environment/disabled/conditional-activation. Two-layer cache: in-process LRU + disk snapshot `.skills_prompt_snapshot.json` validated by mtime/size manifest.
- **Progressive disclosure**: tier 1 `skills_list` → tier 2 `skill_view(name)` (full SKILL.md + `linked_files` map + readiness status) → tier 3 `skill_view(name, file_path=...)`.
- **Slash commands**: each skill maps to `/<slug>` (`agent/skill_commands.py`); invocation wraps the full body in a user message with `[Skill directory: ...]`; up to 5 stacked; bundles from `~/.hermes/skill-bundles/*.yaml` (`agent/skill_bundles.py`).
- Preprocessing on load: `${HERMES_SKILL_DIR}`/`${HERMES_SESSION_ID}` substitution (default on) and `` !`cmd` `` inline-shell (default **off**) (`agent/skill_preprocessing.py`).

### 4.6 Hub, sync, security

- `tools/skills_hub.py`: sources = bundled `optional-skills/`, central index (`HERMES_INDEX_URL = https://hermes-agent.nousresearch.com/docs/api/skills-index.json`, 6h cache), skills.sh, `/.well-known/skills/index.json` (agentskills.io convention — format standard only, no hosted registry), direct URL, GitHub taps, ClawHub, Claude Marketplace, LobeHub, BrowseSh. Install: fetch → quarantine → scan → policy → install → `.hub/lock.json` + `.hub/audit.log`. Trust rank `builtin > trusted > community`; `TRUSTED_REPOS = {openai/skills, anthropics/skills, huggingface/skills, NVIDIA/skills}`.
- `tools/skills_sync.py::sync_skills`: manifest-based reseed/update of bundled skills; user-modified skipped, user-deleted respected.
- `tools/skills_guard.py` (`SCANNER_VERSION = "skills-guard-v1"`): ~70 regex `THREAT_PATTERNS` (exfiltration/injection/destructive/persistence/network/obfuscation), invisible-unicode checks, structure limits → verdict `safe|caution|dangerous`; install policy per trust level. `tools/skills_ast_audit.py`: opt-in AST audit (hints, not verdicts). `tools/threat_patterns.py`: shared scanner (NFKC normalization, 64 KiB cap) also used on memory writes.

## 5. Checkpoints, resumption, sessions

- **Checkpoints (`tools/checkpoint_manager.py`) are filesystem snapshots only — not conversation state.** Single shared shadow git store `~/.hermes/checkpoints/store/` (bare repo, per-project refs `refs/hermes/<sha256(abs_path)[:16]>`, per-project index files; `GIT_CONFIG_GLOBAL/SYSTEM=/dev/null`). `ensure_checkpoint()` runs before file-mutating tools, ≤1 snapshot/dir/turn; skips `/` and `$HOME`, >50k-file dirs, >10 MB files. Retention: 20 snapshots/project, 500 MB global, 7-day prune. `restore()` takes a pre-rollback snapshot first (undo-the-undo). CLI `hermes checkpoints`, in-chat `/rollback <N>`.
- **Long-task resumption = gateway restart recovery + transcript persistence**, not checkpoints: `.clean_shutdown` marker; unclean start → `suspend_recently_active(120s)` marks sessions `resume_pending` → startup synthesizes a MessageEvent per pending session so the agent **auto-continues on the same transcript**. Stuck-loop guard via `restart_counts.json` (3+ restarts → suspend). `SessionEntry.resume_reason ∈ {restart_timeout, shutdown_timeout, restart_interrupted}`.
- **Resume**: `hermes --resume <session_id>`; `SessionDB.resolve_resume_session_id` (`hermes_state.py:6072`) walks compression lineage forward to the tip (depth cap 32); `get_messages_as_conversation(..., repair_alternation=)` replays with `api_content` preferred for prompt-cache stability.
- **Context compression**: summaries stored as ordinary message rows with prefix `[CONTEXT COMPACTION — REFERENCE ONLY]` (`agent/context_compressor.py:98`). Current scheme is **in-place compaction** (`archive_and_compact`, `hermes_state.py:5740`): same session id for life, old rows `active=0, compacted=1` (still FTS-searchable). Legacy rotation mints a child session with `parent_session_id`. Summaries do **not** carry across sessions; cross-session recall is only via `session_search` (which filters compaction payloads out of bookends).
- **Gateway continuity**: `SessionKey = agent:main:{platform}:{chat_type}[:chat_id][:thread_id][:participant_id]`; routing persisted to `sessions/sessions.json` (legacy mirror) + `gateway_routing` table (primary). Reset policy `session_reset: {mode: none|idle|daily|both, at_hour: 4, idle_minutes: 1440}`.
- **Cron**: jobs in `~/.hermes/cron/jobs.json` (record: `id, name, prompt, skills[], model, provider_snapshot, schedule, repeat, enabled, state, deliver, next_run_at, last_run_at, last_status, ...`); execution ledger SQLite `cron/executions.db` (`executions` table with claimed/running/completed/failed/unknown + PID-liveness for interrupted attempts); each run is a full state.db session `cron_{job_id}_{ts}`.

## 6. Config, credentials, install

- **Config**: `~/.hermes/config.yaml` (YAML; template `cli-config.yaml.example`, 1559 lines). Sections incl. `model, terminal, compression, memory, skills, session_reset, delegation, mcp_servers, secrets`. Loader `hermes_cli/config.py` (`load_config/save_config`, atomic writes, corrupt-config backup). `hermes config set` supports dotted keys; secret-looking keys go to `~/.hermes/.env` (chmod 600).
- **Credentials**: `~/.hermes/auth.json` (atomic `O_EXCL`, 0600; dir 0700). `agent/credential_pool.py` multi-credential failover pool. Sources (`agent/credential_sources.py`): `env:<VAR>`, `claude_code` (`~/.claude/.credentials.json`), `hermes_pkce`, `device_code`, `qwen-cli`, `gh_cli`, `config:<name>`, `manual`. `agent/credential_persistence.py` whitelists which (provider, source) pairs may persist raw values; everything else is stripped to fingerprints. External secret managers in `agent/secret_sources/` (1Password `op://`, Bitwarden, user command). No OS-keychain backend. Redaction: `agent/redact.py` (vendor key prefixes, query params).
- **Install/update**: `scripts/install.sh` (uv + Python 3.11 + Node 22; clones repo to `$HERMES_HOME/hermes-agent`). `hermes update` = **git fetch + hard sync + `uv pip install -e .[all]`** (not PyPI); refuses docker/nix/managed installs; pre-update backup. `hermes doctor` diagnostics. Docker: `Dockerfile` (Debian 13, s6-overlay, `/opt/hermes` immutable + `/opt/data` volume).

## 7. Adopt as ideas / import as data / avoid

**Adopt as ideas (re-implement as OmniHarness services):**
- §-delimited curated memory files with **char budgets and model-driven consolidation** (error-embeds-entries, atomic batch ops, per-turn circuit breaker) — simple, cache-friendly, no embedding infra.
- **Frozen prompt snapshot** of memory per session (prefix-cache preservation) with threat-scan-on-snapshot.
- **Nudge-driven background review fork**: turn counters → quiet forked agent with a **runtime tool whitelist** (memory+skills only), digest-vs-full replay depending on model, post-response spawn only on uninterrupted turns.
- **Two-tier skill trust**: `created_by: agent` vs user-owned, with read-before-write and absorbed-into guards on autonomous edits; soft prompt instruction to confirm before create/delete.
- **Progressive skill disclosure** (index → full body → support files) + alphabetical prompt index with mtime-validated snapshot cache.
- **Curator lifecycle** (stale 30d → archive 90d, archive-never-delete, tar.gz snapshot before consolidation, opt-in LLM pass).
- **Write-approval staging** (`pending/<subsystem>/<id>.json` + replay functions) shared across memory and skills.
- Session DB design: insertion-order ids, `active/compacted` soft-delete flags enabling undo **and** searchable archives, `api_content` byte-fidelity sidecar, FTS5 external-content tables with lineage-aware dedup in search.
- In-place compaction (same session id for life) over session rotation.
- Gateway `resume_pending` auto-continue on unclean restart.
- Holographic plugin's scoring recipe (FTS + Jaccard + vector blend × trust, feedback-adjusted trust) if OmniHarness ever adds scored recall.
- Security scanning as a first-class pipeline stage (quarantine → scan → trust-level policy → provenance lock file).

**Import as data (importer targets):**
- `~/.hermes/memories/{MEMORY.md,USER.md}` — split on `\n§\n`; respect 2200/1375 char budgets; no metadata recoverable (no timestamps/IDs).
- `~/.hermes/state.db` — `sessions`/`messages` tables (schema §3.8); use their `create_session`/`append_message` semantics if writing back; `active`/`compacted` flags; honor import caps.
- `~/.hermes/skills/**/SKILL.md` + `references|templates|scripts|assets` — frontmatter per §4.1; identity = frontmatter `name`; write `.usage.json` records (`created_by` decides curator-manageability).
- `~/.hermes/skill-bundles/*.yaml`, `cron/jobs.json` — plain JSON/YAML, directly mappable.
- `~/.hermes/pending/{memory,skills}/*.json` — staged writes (schema §3.6).
- Skip: `checkpoints/store/` (shadow git, machine-specific), `.hub/` caches, honcho remote data.

**Avoid (do not reuse):**
- `agent/conversation_loop.py` + `agent/tool_executor.py` + `run_agent.py`/`cli.py` — the agent loop itself (explicit boundary).
- The provider/credential zoo (`agent/credential_pool.py`, `agent/transports/`, `providers/`) — OmniHarness has its own.
- `gateway/` platform plumbing, `tui_gateway/`, `ui-tui/`, `web/` — product surface, not memory IP.
- The marketing taxonomy "episodic/semantic/procedural/user-model" as literal architecture — in code it's: curated text buffer + FTS5 transcripts + skill files + optional external providers.

## 8. Risks

- **License**: MIT — adoption and even vendoring are fine with attribution; keep `LICENSE` text if any code is ported. Per-plugin dirs (`plugins/security-guidance`, `plugins/hermes-achievements`) have their own LICENSE/NOTICE — check before touching those. `optional-mcps/` are separate upstream projects.
- **Fast-moving target**: 0.19.0 with near-daily commits; this audit is a snapshot of `7168845d`. Interfaces (esp. `hermes_state.py` schema, v23+) churn; pin any importer to a known commit and verify schema version (`state_meta`, `fts_storage_version`).
- **Memory format fragility**: the §-format has no escaping — any memory text containing a literal `\n§\n` corrupts parsing; drift guard will silently back up and reset malformed files. An importer must sanitize entries.
- **No per-entry metadata**: imported memories lose provenance (no timestamps/IDs exist to preserve); char budgets mean large imports will fight the tool's own enforcement.
- **Security posture**: SECURITY.md explicitly scopes out prompt-injection; memory/skill content is treated as trusted once written. Threat scanning is heuristic regex (`skills-guard-v1`). Autonomous skill writes are on by default (`skills.write_approval` false, `curator.consolidate` false but background review active). CVE-2026-10223 (unacknowledged, third-party) alleges `memory_tool.py` injection — treat memory writes as an injection surface in our own design.
- **Supply chain**: repo itself responded to the "Mini Shai-Hulud" worm by exact-pinning all deps; the Skills Hub installs third-party skills from many registries — any hub-like feature we build inherits that risk.
- **Honcho dependency**: the deepest "user model" is a remote/third-party service; adopting that idea means either self-hosting Honcho or accepting an external data dependency.
- **README drift**: e.g. "LLM summarization" for session search was removed in code but still advertised in docs — always verify against source (this audit did).
