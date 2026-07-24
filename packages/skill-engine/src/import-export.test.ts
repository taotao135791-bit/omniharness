import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SkillEngine } from "./engine.js";
import { parseSkillMd } from "./parser.js";
import { InMemorySkillStore } from "./store.js";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "skill-engine-import-"));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function writeSkillMd(dir: string, name: string, description: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "SKILL.md"),
    ["---", `name: ${name}`, `description: ${description}`, "version: 1.0.0", "---", "", `# ${name}`, "", "Body."].join("\n"),
  );
}

function makeEngine(): SkillEngine {
  return new SkillEngine(new InMemorySkillStore());
}

describe("importPiSkills", () => {
  it("imports from .pi/skills and .agents/skills", async () => {
    const engine = makeEngine();
    await writeSkillMd(path.join(tmpRoot, ".pi/skills/pi-one"), "pi-one", "From .pi.");
    await writeSkillMd(path.join(tmpRoot, ".agents/skills/agent-two"), "agent-two", "From .agents.");
    // A dir without SKILL.md is skipped.
    await fs.mkdir(path.join(tmpRoot, ".pi/skills/not-a-skill"), { recursive: true });

    const installed = await engine.importPiSkills(tmpRoot);
    const names = installed.map((s) => s.name).sort();
    expect(names).toEqual(["agent-two", "pi-one"]);
    for (const skill of installed) {
      expect(skill.source).toBe("imported");
      expect(skill.scope).toBe("profile");
    }
  });

  it("returns empty when no pi dirs exist", async () => {
    const engine = makeEngine();
    expect(await engine.importPiSkills(tmpRoot)).toEqual([]);
  });
});

describe("importHermesSkills", () => {
  it("imports recursively, ignoring .usage.json counters", async () => {
    const engine = makeEngine();
    const hermesRoot = path.join(tmpRoot, "hermes");
    await writeSkillMd(path.join(hermesRoot, "skills/git/recovery"), "recovery", "Git recovery.");
    await fs.writeFile(
      path.join(hermesRoot, "skills/git/recovery/.usage.json"),
      JSON.stringify({ useCount: 42, lastUsed: "2026-01-01" }),
    );
    await writeSkillMd(
      path.join(hermesRoot, "skills/nested/deep/reviewer"),
      "reviewer",
      "Deep review.",
    );

    const installed = await engine.importHermesSkills(hermesRoot);
    const names = installed.map((s) => s.name).sort();
    expect(names).toEqual(["recovery", "reviewer"]);
    for (const skill of installed) {
      expect(skill.source).toBe("imported");
    }
  });

  it("returns empty when there is no skills dir", async () => {
    const engine = makeEngine();
    expect(await engine.importHermesSkills(tmpRoot)).toEqual([]);
  });
});

describe("exportSkill", () => {
  it("exports SKILL.md plus resources as a folder copy", async () => {
    const engine = makeEngine();
    const srcDir = path.join(tmpRoot, "src-skill");
    await writeSkillMd(srcDir, "exportable", "Export me.");
    await fs.mkdir(path.join(srcDir, "scripts"), { recursive: true });
    await fs.writeFile(path.join(srcDir, "scripts/run.sh"), "echo hello");

    const skill = await engine.installFromDir(srcDir, { scope: "workspace", source: "local" });
    const destDir = path.join(tmpRoot, "out", "exportable");
    await engine.exportSkill(skill.id, destDir);

    const exported = parseSkillMd(await fs.readFile(path.join(destDir, "SKILL.md"), "utf8"));
    expect(exported.name).toBe("exportable");
    expect(exported.description).toBe("Export me.");
    expect(await fs.readFile(path.join(destDir, "scripts/run.sh"), "utf8")).toBe("echo hello");
  });

  it("round-trips: an exported dir can be re-installed", async () => {
    const engine = makeEngine();
    const srcDir = path.join(tmpRoot, "round-trip");
    await writeSkillMd(srcDir, "round-trip", "Round trip.");
    const skill = await engine.installFromDir(srcDir, { scope: "global", source: "local" });
    const destDir = path.join(tmpRoot, "out2");
    await engine.exportSkill(skill.id, destDir);
    const reinstalled = await engine.installFromDir(destDir, {
      scope: "global",
      source: "imported",
    });
    expect(reinstalled.name).toBe("round-trip");
    expect(reinstalled.body).toBe(skill.body);
  });
});
