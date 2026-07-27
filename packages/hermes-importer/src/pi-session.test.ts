import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  MessageId,
  ProfileId,
  ProjectId,
  SessionId,
  WorkspaceId,
} from "@omniharness/shared-types";
import { type OmniDatabase, openDatabase } from "@omniharness/session-store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { importPiSession } from "./pi-session.js";

export function seedDb(): {
  db: OmniDatabase;
  profileId: ProfileId;
  projectId: ProjectId;
  workspaceId: WorkspaceId;
} {
  const db = openDatabase(":memory:");
  const profileId = "prof_test" as ProfileId;
  const projectId = "proj_test" as ProjectId;
  const workspaceId = "ws_test" as WorkspaceId;
  db.profiles.put({
    id: profileId,
    name: "Test",
    isDefault: true,
    createdAt: new Date().toISOString(),
  });
  db.projects.put({ id: projectId, name: "Test", createdAt: new Date().toISOString() });
  db.workspaces.put({
    id: workspaceId,
    projectId,
    name: "main",
    kind: "git",
    roots: ["/repo"],
    protectedPaths: [],
    readOnlyPaths: [],
    createdAt: new Date().toISOString(),
  });
  return { db, profileId, projectId, workspaceId };
}

let dir: string;
let db: OmniDatabase;
let workspaceId: WorkspaceId;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omni-import-test-"));
  const seeded = seedDb();
  db = seeded.db;
  workspaceId = seeded.workspaceId;
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function writeJsonl(name: string, lines: unknown[]): string {
  const path = join(dir, name);
  writeFileSync(
    path,
    lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n",
  );
  return path;
}

const HEADER = {
  type: "session",
  version: 3,
  id: "sess-uuid-1",
  timestamp: "2026-07-01T10:00:00.000Z",
  cwd: "/repo",
};

describe("importPiSession", () => {
  it("imports a session with branches and preserves the tree", () => {
    const path = writeJsonl("session.jsonl", [
      HEADER,
      {
        type: "session_info",
        id: "a0",
        parentId: null,
        timestamp: "2026-07-01T10:00:01.000Z",
        name: "My chat",
      },
      {
        type: "message",
        id: "a1",
        parentId: "a0",
        timestamp: "2026-07-01T10:00:02.000Z",
        message: { role: "user", content: "hello", timestamp: 1 },
      },
      {
        type: "message",
        id: "b1",
        parentId: "a1",
        timestamp: "2026-07-01T10:00:03.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "hi" },
            { type: "thinking", thinking: "hmm" },
          ],
          provider: "anthropic",
          model: "claude",
          api: "anthropic-messages",
          usage: {
            input: 5,
            output: 3,
            cacheRead: 1,
            cacheWrite: 0,
            totalTokens: 9,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
          },
          stopReason: "stop",
          timestamp: 2,
        },
      },
      // Branch: two children of a1.
      {
        type: "message",
        id: "c1",
        parentId: "a1",
        timestamp: "2026-07-01T10:00:04.000Z",
        message: { role: "user", content: "branch two", timestamp: 3 },
      },
      {
        type: "message",
        id: "d1",
        parentId: "b1",
        timestamp: "2026-07-01T10:00:05.000Z",
        message: {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "bash",
          content: [{ type: "text", text: "ok" }],
          isError: false,
          timestamp: 4,
        },
      },
      {
        type: "model_change",
        id: "e1",
        parentId: "d1",
        timestamp: "2026-07-01T10:00:06.000Z",
        provider: "openai",
        modelId: "gpt-5",
      },
      {
        type: "compaction",
        id: "f1",
        parentId: "e1",
        timestamp: "2026-07-01T10:00:07.000Z",
        summary: "so far...",
        firstKeptEntryId: "c1",
        tokensBefore: 12345,
      },
      {
        type: "custom_message",
        id: "g1",
        parentId: "f1",
        timestamp: "2026-07-01T10:00:08.000Z",
        customType: "my-ext",
        content: "injected",
        display: true,
      },
      {
        type: "weird_ext_entry",
        id: "h1",
        parentId: "g1",
        timestamp: "2026-07-01T10:00:09.000Z",
        payload: { x: 1 },
      },
    ]);

    const report = importPiSession(path, db, { workspaceId });
    expect(report.errors).toEqual([]);
    expect(report.imported).toBe(9); // 9 entries
    // Unknown kind preserved as raw, with a warning.
    expect(report.warnings.some((w) => w.includes("weird_ext_entry"))).toBe(true);

    const session = db.sessions.get("sess_pi_sess-uuid-1" as SessionId);
    expect(session).toBeDefined();
    expect(session!.title).toBe("My chat");
    expect(session!.headMessageId).toBe("msg_pi_sess-uuid-1_h1");

    // Tree: a1 has two children (b1, c1) — the branch survived.
    const branches = db.messages.branches("msg_pi_sess-uuid-1_a1" as MessageId);
    expect(branches.map((m) => m.id).sort()).toEqual([
      "msg_pi_sess-uuid-1_b1",
      "msg_pi_sess-uuid-1_c1",
    ]);

    // Roles mapped.
    const user = db.messages.get("msg_pi_sess-uuid-1_a1" as MessageId)!;
    expect(user.role).toBe("user");
    const assistant = db.messages.get("msg_pi_sess-uuid-1_b1" as MessageId)!;
    expect(assistant.role).toBe("assistant");
    expect(assistant.modelId).toBe("anthropic/claude");
    expect(assistant.usage?.inputTokens).toBe(5);
    expect(assistant.parts.map((p) => p.type)).toEqual(["text", "reasoning"]);
    const tool = db.messages.get("msg_pi_sess-uuid-1_d1" as MessageId)!;
    expect(tool.role).toBe("tool");
    expect(tool.parts[0]?.type).toBe("tool_result");
    expect(tool.parts[0]?.toolCallId).toBe("call_1");

    // Marker entries became system messages; custom_message became user.
    expect(db.messages.get("msg_pi_sess-uuid-1_e1" as MessageId)!.role).toBe("system");
    expect(db.messages.get("msg_pi_sess-uuid-1_f1" as MessageId)!.parts[0]?.text).toContain(
      "[pi:compaction",
    );
    expect(db.messages.get("msg_pi_sess-uuid-1_g1" as MessageId)!.role).toBe("user");

    // Unknown kind preserved raw (not dropped).
    const raw = db.messages.get("msg_pi_sess-uuid-1_h1" as MessageId)!;
    expect(raw.role).toBe("system");
    expect(raw.parts[0]?.text).toContain("weird_ext_entry");
  });

  it("is idempotent: re-import skips the session", () => {
    const path = writeJsonl("s.jsonl", [
      HEADER,
      {
        type: "message",
        id: "a1",
        parentId: null,
        timestamp: "2026-07-01T10:00:02.000Z",
        message: { role: "user", content: "hi", timestamp: 1 },
      },
    ]);
    const first = importPiSession(path, db, { workspaceId });
    expect(first.imported).toBe(1);
    const second = importPiSession(path, db, { workspaceId });
    expect(second.imported).toBe(0);
    expect(second.skipped).toEqual([
      { id: "sess-uuid-1", reason: "already imported as sess_pi_sess-uuid-1" },
    ]);
    expect(db.messages.listBySession("sess_pi_sess-uuid-1" as SessionId).total).toBe(1);
  });

  it("reports malformed JSONL lines as errors and continues", () => {
    const path = writeJsonl("bad.jsonl", [
      HEADER,
      "{not json",
      {
        type: "message",
        id: "a1",
        parentId: null,
        timestamp: "2026-07-01T10:00:02.000Z",
        message: { role: "user", content: "still here", timestamp: 1 },
      },
    ]);
    const report = importPiSession(path, db, { workspaceId });
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]?.id).toBe("line 2");
    expect(report.imported).toBe(1);
    expect(db.messages.listBySession("sess_pi_sess-uuid-1" as SessionId).total).toBe(1);
  });

  it("rejects a file without a session header", () => {
    const path = writeJsonl("noheader.jsonl", [
      { type: "message", id: "a1", parentId: null, message: { role: "user", content: "x" } },
    ]);
    const report = importPiSession(path, db, { workspaceId });
    expect(report.imported).toBe(0);
    expect(report.errors[0]?.message).toContain("session header");
  });

  it("dry-run reports but writes nothing", () => {
    const path = writeJsonl("dry.jsonl", [
      HEADER,
      {
        type: "message",
        id: "a1",
        parentId: null,
        timestamp: "2026-07-01T10:00:02.000Z",
        message: { role: "user", content: "hi", timestamp: 1 },
      },
    ]);
    const report = importPiSession(path, db, { workspaceId, dryRun: true });
    expect(report.imported).toBe(1);
    expect(db.sessions.get("sess_pi_sess-uuid-1" as SessionId)).toBeUndefined();
    // A real run afterwards is NOT considered a re-import.
    const real = importPiSession(path, db, { workspaceId });
    expect(real.imported).toBe(1);
  });
});
