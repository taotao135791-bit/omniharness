import type { FieldDef } from "./field.js";

/**
 * The one and only product settings schema. Config validation, CLI flags,
 * TUI settings forms, GUI settings pages, defaults and docs are all generated
 * from this list.
 */
export const SETTINGS_SCHEMA: readonly FieldDef[] = [
  // daemon
  { key: "daemon.host", type: "string", description: "Bind address for the local RPC server. Loopback only by default.", default: "127.0.0.1", scope: "global" },
  { key: "daemon.port", type: "number", description: "Local RPC port. 0 = pick a free port and write it to the runtime file.", default: 0, min: 0, max: 65535, scope: "global" },
  { key: "daemon.autoStart", type: "boolean", description: "Start the daemon automatically when a client launches.", default: true, scope: "global" },
  { key: "daemon.logLevel", type: "enum", description: "Structured log verbosity.", default: "info", enumValues: ["debug", "info", "warn", "error"], scope: "session" },
  { key: "daemon.maxParallelAgents", type: "number", description: "Backpressure limit for concurrent agent runs.", default: 10, min: 1, max: 64, scope: "global" },

  // models
  { key: "models.defaultModelId", type: "string", description: "Model used for the primary agent role when no binding exists.", default: "", scope: "session" },
  { key: "models.temperature", type: "number", description: "Sampling temperature for the primary agent.", default: 0.2, min: 0, max: 2, scope: "session" },
  { key: "models.requestTimeoutMs", type: "number", description: "Per-request timeout for model calls.", default: 120000, min: 1000, scope: "profile" },
  { key: "models.maxRetries", type: "number", description: "Retries with exponential backoff for transient model errors.", default: 3, min: 0, max: 10, scope: "profile" },
  { key: "models.fallbackOnRateLimit", type: "boolean", description: "Switch to the next fallback model when the primary is rate-limited.", default: true, scope: "profile" },
  { key: "models.monthlyCostBudgetUsd", type: "number", description: "Soft monthly spend cap across all providers. 0 = unlimited.", default: 0, min: 0, scope: "profile" },

  // context / compaction
  { key: "context.compactionThreshold", type: "number", description: "Fraction of the context window that triggers compaction.", default: 0.8, min: 0.3, max: 0.95, scope: "session" },
  { key: "context.maxToolOutputChars", type: "number", description: "Tool outputs beyond this are truncated and artifacted.", default: 20000, min: 1000, scope: "session" },
  { key: "context.includeMemory", type: "boolean", description: "Retrieve relevant memory into the system context.", default: true, scope: "session" },

  // policy defaults
  { key: "policy.defaultShell", type: "enum", description: "Default policy for shell execution.", default: "ask_every_time", enumValues: ["deny", "ask_every_time", "ask_once_per_session", "allow_for_workspace", "allow_with_constraints", "always_allow"], scope: "project" },
  { key: "policy.defaultFsWrite", type: "enum", description: "Default policy for file writes inside the workspace.", default: "allow_for_workspace", enumValues: ["deny", "ask_every_time", "ask_once_per_session", "allow_for_workspace", "always_allow"], scope: "project" },
  { key: "policy.defaultNetwork", type: "enum", description: "Default policy for network access from tools.", default: "ask_every_time", enumValues: ["deny", "ask_every_time", "ask_once_per_session", "allow_with_constraints", "always_allow"], scope: "project" },
  { key: "policy.networkAllowlist", type: "string[]", description: "Domains tools may reach when network is constrained.", default: [], scope: "project" },
  { key: "policy.approvalTimeoutMs", type: "number", description: "Approval requests expire after this long.", default: 300000, min: 10000, scope: "profile" },

  // sandbox
  { key: "sandbox.backend", type: "enum", description: "Execution isolation backend for shell commands.", default: "auto", enumValues: ["auto", "none", "seatbelt", "appcontainer", "namespace", "docker", "ssh"], scope: "project" },
  { key: "sandbox.dockerImage", type: "string", description: "Image for the docker sandbox backend.", default: "omniharness/sandbox:latest", scope: "project" },
  { key: "sandbox.sshTarget", type: "string", description: "user@host for the ssh sandbox backend.", default: "", scope: "project" },
  { key: "sandbox.cpuLimitPercent", type: "number", description: "CPU cap for sandboxed processes. 0 = unlimited.", default: 0, min: 0, max: 100, scope: "project" },
  { key: "sandbox.memoryLimitMb", type: "number", description: "Memory cap for sandboxed processes. 0 = unlimited.", default: 0, min: 0, scope: "project" },
  { key: "sandbox.timeoutMs", type: "number", description: "Wall-clock limit for a single sandboxed command.", default: 300000, min: 1000, scope: "project" },

  // tui
  { key: "tui.theme", type: "enum", description: "TUI color theme.", default: "auto", enumValues: ["auto", "dark", "light", "mono"], scope: "profile" },
  { key: "tui.showTokenUsage", type: "boolean", description: "Show token/cost meter in the status line.", default: true, scope: "profile" },
  { key: "tui.collapseToolCalls", type: "boolean", description: "Collapse long tool outputs by default.", default: true, scope: "profile" },
  { key: "tui.editorCommand", type: "string", description: "External editor for multiline input (empty = $EDITOR).", default: "", scope: "profile" },

  // gui
  { key: "gui.theme", type: "enum", description: "Desktop UI theme.", default: "system", enumValues: ["system", "dark", "light"], scope: "profile" },
  { key: "gui.language", type: "enum", description: "UI language.", default: "system", enumValues: ["system", "en", "zh-CN"], scope: "profile" },
  { key: "gui.globalHotkey", type: "string", description: "Global shortcut to toggle the window (Electron accelerator).", default: "CommandOrControl+Shift+Space", scope: "global" },
  { key: "gui.minimizeToTray", type: "boolean", description: "Keep running in the system tray when the window closes.", default: true, scope: "global" },

  // memory
  { key: "memory.enabled", type: "boolean", description: "Enable the long-term memory engine.", default: true, scope: "profile" },
  { key: "memory.maxEntriesPerQuery", type: "number", description: "Max memories injected into one context build.", default: 8, min: 0, max: 50, scope: "profile" },
  { key: "memory.autoPropose", type: "boolean", description: "Agent may propose memories (still requires approval).", default: true, scope: "profile" },

  // automation
  { key: "automation.enabled", type: "boolean", description: "Run the scheduler while the daemon is up.", default: true, scope: "global" },
  { key: "automation.maxConcurrentRuns", type: "number", description: "Concurrent automation runs.", default: 3, min: 1, max: 16, scope: "global" },

  // telemetry
  { key: "telemetry.crashReports", type: "boolean", description: "Send crash reports. Off by default; explicit opt-in only.", default: false, scope: "global" },
  { key: "telemetry.anonymousUsage", type: "boolean", description: "Send anonymous usage stats. Off by default.", default: false, scope: "global" },

  // updates
  { key: "updates.channel", type: "enum", description: "Auto-update channel.", default: "stable", enumValues: ["stable", "beta"], scope: "global" },
  { key: "updates.autoCheck", type: "boolean", description: "Check for updates in the background.", default: true, scope: "global" },
] as const;
