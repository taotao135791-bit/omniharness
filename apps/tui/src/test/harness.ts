import type {
  ApprovalRequest,
  DiffResult,
  Message,
  ModelDefinition,
  ProviderConfig,
  Session,
} from "@omniharness/agent-protocol";
import type { SessionId } from "@omniharness/shared-types";
import { DEFAULT_CAPABILITIES } from "@omniharness/shared-types";
import { OmniClient } from "@omniharness/client-sdk";
import { AppController } from "../core/app-controller.js";
import { FakeDaemon } from "./fake-daemon.js";

/** Cast a plain string to a branded ID for fixtures/events. */
export const sid = (s: string): SessionId => s as SessionId;

import type { ToolCallId } from "/shared-types";
export const tid = (s: string): ToolCallId => s as ToolCallId;

/** Un-brands top-level string fields so fixtures accept plain strings. */
type Loose<T> = {
  [K in keyof T]: T[K] extends string ? string : T[K] extends string | null ? string | null : T[K];
};

export function makeSession(overrides: Partial<Loose<Session>> = {}): Session {
  return {
    id: "sess-1",
    profileId: "prof-1",
    projectId: "proj-1",
    workspaceId: "ws-1",
    title: "Test session",
    tags: [],
    status: "active",
    headMessageId: null,
    createdAt: "2026-07-20T10:00:00.000Z",
    updatedAt: "2026-07-20T11:00:00.000Z",
    totalUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ...overrides,
  } as Session;
}

export function makeMessage(overrides: Partial<Loose<Message>> = {}): Message {
  return {
    id: "msg-1",
    sessionId: "sess-1",
    parentId: null,
    role: "user",
    parts: [{ type: "text", text: "hello" }],
    createdAt: "2026-07-20T10:00:00.000Z",
    ...overrides,
  } as Message;
}

export function makeApproval(overrides: Partial<Loose<ApprovalRequest>> = {}): ApprovalRequest {
  return {
    id: "appr-1",
    toolCallId: "tc-1",
    capability: "shell.exec",
    risk: "high",
    summary: "Run shell command: rm -rf /tmp/x",
    detail: { command: "rm -rf /tmp/x" },
    status: "pending",
    createdAt: "2026-07-20T10:00:00.000Z",
    resolvedAt: null,
    resolvedBy: null,
    expiresAt: "2026-07-20T10:05:00.000Z",
    ...overrides,
  } as ApprovalRequest;
}

export function makeProvider(overrides: Partial<Loose<ProviderConfig>> = {}): ProviderConfig {
  return {
    id: "prov-1",
    kind: "openai",
    displayName: "OpenAI",
    enabled: true,
    rateLimitRpm: 0,
    timeoutMs: 120000,
    maxRetries: 3,
    ...overrides,
  } as ProviderConfig;
}

export function makeModel(overrides: Partial<Loose<ModelDefinition>> = {}): ModelDefinition {
  return {
    id: "model-1",
    providerId: "prov-1",
    remoteName: "gpt-test",
    displayName: "GPT Test",
    capabilities: {
      ...DEFAULT_CAPABILITIES,
      vision: true,
      nativeToolCalling: true,
      contextWindow: 128000,
    },
    enabled: true,
    ...overrides,
  } as ModelDefinition;
}

export function makeDiff(): DiffResult {
  return {
    files: [
      {
        path: "src/foo.ts",
        status: "modified",
        additions: 3,
        deletions: 1,
        hunks: [
          {
            index: 0,
            header: "@@ -1,3 +1,5 @@",
            lines: [" context", "-old line", "+new line", "+another"],
            accepted: null,
          },
          {
            index: 1,
            header: "@@ -10,2 +12,2 @@",
            lines: [" context", "-x", "+y"],
            accepted: null,
          },
        ],
      },
      {
        path: "src/bar.ts",
        status: "added",
        additions: 10,
        deletions: 0,
        hunks: [
          { index: 0, header: "@@ -0,0 +1,10 @@", lines: ["+export const x = 1;"], accepted: null },
        ],
      },
    ],
    truncated: false,
  };
}

export interface TestHarness {
  daemon: FakeDaemon;
  client: OmniClient;
  controller: AppController;
  errors: string[];
}

/** Connect a real OmniClient + AppController to a FakeDaemon. */
export async function connectController(
  daemon: FakeDaemon,
  onChange: () => void = () => undefined,
): Promise<TestHarness> {
  const client = new OmniClient({
    url: daemon.url,
    authToken: "test-token",
    client: { kind: "tui", name: "omni-tui-test", version: "0" },
    autoReconnect: false,
  });
  const errors: string[] = [];
  const controller = new AppController(client, {
    onChange,
    onError: (message) => errors.push(message),
  });
  await client.connect();
  controller.attach();
  return { daemon, client, controller, errors };
}

/** Standard handlers every controller init needs. */
export function registerBaseHandlers(daemon: FakeDaemon, sessions: Session[] = []): void {
  daemon.on("session.list", (params) => ({
    sessions,
    total: sessions.length + ((params.offset as number) ?? 0),
  }));
  daemon.on("settings.get", () => ({ settings: {} }));
  daemon.on("approval.list", () => ({ approvals: [] }));
  daemon.on("model.getRoleBindings", () => ({ bindings: {} }));
}

/** Wait until a predicate holds (event-driven state settles async). */
export async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
