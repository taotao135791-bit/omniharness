import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryId, SessionId, SkillDefinition } from "@omniharness/shared-types";
import type { OmniDatabase } from "@omniharness/session-store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HermesImporter } from "./hermes.js";
import { parseHermesMemoryFile, sanitizeMemoryText } from "./hermes-memories.js";
import { parseHermesSkillMd } from "./hermes-skills.js";
import { seedDb } from "./pi-session.test.js";

let dir: string;
let db: OmniDatabase;
let workspaceId: ReturnType<typeof seedDb>["workspaceId"];
let profileId: ReturnType<typeof seedDb>["profileId"];
let importer: HermesImporter;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omni-hermes-test-"));
  const seeded = seedDb();
  db = seeded.db;
  workspaceId = seeded.workspaceId;
  profileId = seeded.profileId;
  importer = new HermesImporter(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("Hermes memories (MEMORY.md / USER.md)", () => {
  it("splits on §, sanitizes control chars, dedupes", () => {
    expect(parseHermesMemoryFile("one\n§\ntwo § still-one-entry\n§\none\n§\n\n")).toEqual([
      "one",
      "two § still-one-entry",
    ]);
    expect(sanitizeMemoryText("a\x00b\x07c\td\ne")).toBe("abc\td\ne");
  });

  it("imports MEMORY.md as semantic and USER.md as userPreference with provenance", () => {
    const memoryMd = join(dir, "MEMORY.md");
    const userMd = join(dir, "USER.md");
    writeFileSync(memoryMd, "Project uses Axum + SQLx\n§\nMachine runs Ubuntu 22.04\x00\n");
    writeFileSync(userMd, "Prefers terse answers\n");

    const report = importer.importMemories({ memoryMdPath: memoryMd, userMdPath: userMd, profileId });
    expect(report.errors).toEqual([]);
    expect(report.imported).toBe(3);

    const semantic = db.memories.listByProfile(profileId, "semantic");
    expect(semantic).toHaveLength(2);
    expect(semantic[0]!.createdBy).toBe("import");
    expect(semantic[0]!.evidenceRefs[0]).toContain("MEMORY.md");
    expect(semantic.map((m) => m.content)).toContain("Machine runs Ubuntu 22.04"); // \x00 stripped
    const prefs = db.memories.listByProfile(profileId, "userPreference");
    expect(prefs).toHaveLength(1);
    expect(prefs[0]!.content).toBe("Prefers terse answers");

    // Idempotent.
    const again = importer.importMemories({ memoryMdPath: memoryMd, userMdPath: userMd, profileId });
    expect(again.imported).toBe(0);
    expect(again.skipped).toHaveLength(3);
  });
});

function createStateDb(path: string): void {
  const source = new DatabaseSync(path);
  source.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, source TEXT, title TEXT, display_name TEXT, model TEXT,
      started_at REAL, ended_at REAL, end_reason TEXT, archived INTEGER DEFAULT 0
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT,
      tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL,
      reasoning TEXT, active INTEGER DEFAULT 1, compacted INTEGER DEFAULT 0
    );
    CREATE VIRTUAL TABLE messages_fts USING fts5(content);
  `);
  // Live session.
  source
    .prepare("INSERT INTO sessions (id, source, title, started_at, archived) VALUES (?, ?, ?, ?, 0)")
    .run("20260701_100000_abcd1234", "cli", "Live chat", 1_751_000_000);
  const ins = source.prepare(
    "INSERT INTO messages (session_id, role, content, timestamp, active, compacted) VALUES (?, ?, ?, ?, ?, ?)",
  );
  ins.run("20260701_100000_abcd1234", "user", "hello", 1_751_000_001, 1, 0);
  ins.run("20260701_100000_abcd1234", "assistant", "hi there", 1_751_000_002, 1, 0);
  ins.run("20260701_100000_abcd1234", "user", "undone question", 1_751_000_003, 0, 0); // rewound

  // Compacted session (ended via compression).
  source
    .prepare("INSERT INTO sessions (id, source, title, started_at, ended_at, end_reason, archived) VALUES (?, ?, ?, ?, ?, ?, 0)")
    .run("20260601_090000_deadbeef", "cli", "Old chat", 1_750_000_000, 1_750_100_000, "compression");
  ins.run("20260601_090000_deadbeef", "user", "old q1", 1_750_000_001, 0, 1);
  ins.run("20260601_090000_deadbeef", "assistant", "old a1", 1_750_000_002, 0, 1);
  ins.run("20260601_090000_deadbeef", "assistant", "[CONTEXT COMPACTION — REFERENCE ONLY] summary of old chat", 1_750_000_003, 1, 0);
  ins.run("20260601_090000_deadbeef", "user", "fresh question", 1_750_000_004, 1, 0);
  source.close();
}

describe("Hermes sessions (state.db)", () => {
  it("imports sessions incl. compacted history, statuses and markers", () => {
    const stateDb = join(dir, "state.db");
    createStateDb(stateDb);

    const report = importer.importSessions({ stateDbPath: stateDb, workspaceId });
    expect(report.errors).toEqual([]);
    // 2 sessions + (2 live + 4 compacted-session + 1 synthetic marker) messages.
    expect(report.imported).toBe(2 + 2 + 5);
    expect(report.skipped).toEqual([
      { id: "20260701_100000_abcd1234/3", reason: "rewound message (active=0, compacted=0)" },
    ]);

    const live = db.sessions.get("sess_hermes_20260701_100000_abcd1234" as SessionId)!;
    expect(live.status).toBe("active");
    expect(live.title).toBe("Live chat");
    const liveMessages = db.messages.listBySession(live.id);
    expect(liveMessages.total).toBe(2);
    expect(liveMessages.items[0]!.role).toBe("user");
    expect(liveMessages.items[1]!.parentId).toBe(liveMessages.items[0]!.id);
    expect(live.headMessageId).toBe(liveMessages.items[1]!.id);

    const old = db.sessions.get("sess_hermes_20260601_090000_deadbeef" as SessionId)!;
    expect(old.status).toBe("archived"); // ended_at set
    expect(old.tags).toContain("end:compression");
    const oldMessages = db.messages.listBySession(old.id).items;
    // 4 source rows + 1 synthetic compaction marker inserted after the compacted rows.
    expect(oldMessages).toHaveLength(5);
    const marker = oldMessages.find((m) => m.id.includes("compaction-marker"));
    expect(marker).toBeDefined();
    expect(marker!.role).toBe("system");
    expect(marker!.parts[0]?.text).toContain("2 earlier message(s)");
    const summary = oldMessages.find((m) => m.parts[0]?.text?.includes("CONTEXT COMPACTION"));
    expect(summary!.role).toBe("system");
    // Compacted rows were imported too (still part of history).
    expect(oldMessages[0]!.parts[0]?.text).toBe("old q1");

    // Idempotent.
    const again = importer.importSessions({ stateDbPath: stateDb, workspaceId });
    expect(again.imported).toBe(0);
    expect(again.skipped.filter((s) => s.reason.includes("already imported"))).toHaveLength(2);
  });

  it("errors cleanly on a database without the expected tables", () => {
    const bogus = join(dir, "bogus.db");
    const source = new DatabaseSync(bogus);
    source.exec("CREATE TABLE something_else (id INTEGER)");
    source.close();
    const report = importer.importSessions({ stateDbPath: bogus, workspaceId });
    expect(report.imported).toBe(0);
    expect(report.errors[0]?.message).toContain("sessions/messages");
  });
});

describe("Hermes skills", () => {
  it("parses SKILL.md frontmatter tolerantly", () => {
    const parsed = parseHermesSkillMd(
      [
        "---",
        "name: deploy-api",
        'description: "Deploy the API: safely"',
        "version: 1.2.3",
        "platforms:",
        "  - macos",
        "metadata:",
        "  hermes:",
        "    tags: [ops]",
        "---",
        "",
        "Do the deploy.",
      ].join("\n"),
    );
    expect(parsed.frontmatter).toEqual({ name: "deploy-api", description: "Deploy the API: safely", version: "1.2.3" });
    expect(parsed.body).toBe("Do the deploy.");
    expect(() => parseHermesSkillMd("---\ndescription: x\n---\nbody")).toThrow(/name/);
    expect(() => parseHermesSkillMd("no frontmatter")).toThrow(/fence/);
  });

  it("converts skills and routes them through the injected callback", async () => {
    const skillsDir = join(dir, "skills");
    mkdirSync(join(skillsDir, "ops", "deploy-api", "references"), { recursive: true });
    writeFileSync(
      join(skillsDir, "ops", "deploy-api", "SKILL.md"),
      "---\nname: deploy-api\ndescription: Deploy the API\nversion: 2.0.0\n---\n\nSteps here.\n",
    );
    writeFileSync(join(skillsDir, "ops", "deploy-api", "references", "runbook.md"), "runbook");
    mkdirSync(join(skillsDir, "old-skill"), { recursive: true });
    writeFileSync(join(skillsDir, "old-skill", "SKILL.md"), "---\nname: old-skill\ndescription: Archived one\n---\n\nOld body.\n");
    mkdirSync(join(skillsDir, "broken"), { recursive: true });
    writeFileSync(join(skillsDir, "broken", "SKILL.md"), "no frontmatter at all");
    writeFileSync(
      join(skillsDir, ".usage.json"),
      JSON.stringify({ "old-skill": { state: "archived", use_count: 4 } }),
    );

    const received: SkillDefinition[] = [];
    const report = await importer.importSkills({ skillsDir, onSkill: (s) => { received.push(s); } });
    expect(report.imported).toBe(2);
    expect(report.errors).toHaveLength(1); // broken SKILL.md
    expect(received).toHaveLength(2);

    const deploy = received.find((s) => s.name === "deploy-api")!;
    expect(deploy.id).toBe("skill_hermes_deploy-api");
    expect(deploy.version).toBe("2.0.0");
    expect(deploy.source).toBe("imported");
    expect(deploy.enabled).toBe(true);
    expect(deploy.resources).toEqual(["references/runbook.md"]);
    expect(deploy.sourcePath).toContain("SKILL.md");

    const old = received.find((s) => s.name === "old-skill")!;
    expect(old.enabled).toBe(false); // archived in .usage.json
    expect(report.warnings.some((w) => w.includes("old-skill"))).toBe(true);

    // Idempotent.
    const again = await importer.importSkills({ skillsDir, onSkill: (s) => { received.push(s); } });
    expect(again.imported).toBe(0);
    expect(again.skipped).toHaveLength(2);
    expect(received).toHaveLength(2);
  });

  it("dry-run converts nothing and calls no callback", async () => {
    const skillsDir = join(dir, "skills");
    mkdirSync(join(skillsDir, "a"), { recursive: true });
    writeFileSync(join(skillsDir, "a", "SKILL.md"), "---\nname: a\ndescription: A\n---\n\nbody\n");
    const received: SkillDefinition[] = [];
    const report = await importer.importSkills({ skillsDir, dryRun: true, onSkill: (s) => { received.push(s); } });
    expect(report.imported).toBe(1);
    expect(received).toHaveLength(0);
  });
});
