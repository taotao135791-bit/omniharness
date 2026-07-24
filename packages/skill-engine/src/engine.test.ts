import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SkillDefinition } from "@omniharness/shared-types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SkillEngine, SkillEngineError } from "./engine.js";
import { InMemorySkillStore } from "./store.js";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "skill-engine-test-"));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function makeSkillDir(
  name: string,
  options: { description?: string; capabilities?: string[]; files?: Record<string, string> } = {},
): Promise<string> {
  const dir = path.join(tmpRoot, `dir-${name}-${crypto.randomUUID().slice(0, 8)}`);
  await fs.mkdir(dir, { recursive: true });
  const caps = options.capabilities ?? ["fs.read"];
  const skillMd = [
    "---",
    `name: ${name}`,
    `description: ${options.description ?? `The ${name} skill.`}`,
    "version: 1.0.0",
    `requiredCapabilities: [${caps.map((c) => JSON.stringify(c)).join(", ")}]`,
    "---",
    "",
    `# ${name}`,
    "",
    "Do the thing.",
  ].join("\n");
  await fs.writeFile(path.join(dir, "SKILL.md"), skillMd);
  for (const [rel, content] of Object.entries(options.files ?? {})) {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
  return dir;
}

function makeEngine(): { engine: SkillEngine; store: InMemorySkillStore } {
  const store = new InMemorySkillStore();
  return { engine: new SkillEngine(store), store };
}

describe("SkillEngine install", () => {
  it("installs from a local dir with resources", async () => {
    const { engine } = makeEngine();
    const dir = await makeSkillDir("alpha", { files: { "scripts/run.sh": "echo hi" } });
    const skill = await engine.installFromDir(dir, { scope: "project", source: "local" });
    expect(skill.name).toBe("alpha");
    expect(skill.scope).toBe("project");
    expect(skill.enabled).toBe(true);
    expect(skill.resources).toEqual(["scripts/run.sh"]);
    expect(skill.requiredCapabilities).toEqual(["fs.read"]);
    expect(skill.sourcePath).toBe(dir);
  });

  it("rejects unknown capabilities", async () => {
    const { engine } = makeEngine();
    const dir = await makeSkillDir("bad-cap", { capabilities: ["fs.fly"] });
    await expect(engine.installFromDir(dir, { scope: "global", source: "local" })).rejects.toThrow(
      /unknown capabilities/,
    );
  });

  it("rejects a missing SKILL.md", async () => {
    const { engine } = makeEngine();
    const dir = path.join(tmpRoot, "empty");
    await fs.mkdir(dir, { recursive: true });
    await expect(engine.installFromDir(dir, { scope: "global", source: "local" })).rejects.toThrow(
      /no SKILL.md/,
    );
  });

  it("rejects a SKILL.md missing required fields", async () => {
    const { engine } = makeEngine();
    const dir = path.join(tmpRoot, "invalid");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "SKILL.md"), "---\ndescription: no name\n---\n\nbody");
    await expect(engine.installFromDir(dir, { scope: "global", source: "local" })).rejects.toThrow(
      /"name"/,
    );
  });
});

describe("enable / disable / uninstall", () => {
  it("toggles enabled state", async () => {
    const { engine } = makeEngine();
    const dir = await makeSkillDir("toggle");
    const skill = await engine.installFromDir(dir, { scope: "global", source: "local" });
    await engine.disable(skill.id);
    expect((await engine.get(skill.id))?.enabled).toBe(false);
    await engine.enable(skill.id);
    expect((await engine.get(skill.id))?.enabled).toBe(true);
  });

  it("uninstalls a skill", async () => {
    const { engine } = makeEngine();
    const dir = await makeSkillDir("gone");
    const skill = await engine.installFromDir(dir, { scope: "global", source: "local" });
    await engine.uninstall(skill.id);
    expect(await engine.get(skill.id)).toBeNull();
  });

  it("throws on unknown ids", async () => {
    const { engine } = makeEngine();
    await expect(engine.enable("skl_missing" as SkillDefinition["id"])).rejects.toThrow(
      SkillEngineError,
    );
  });
});

describe("scope precedence", () => {
  it("higher scope shadows lower scope for the same name", async () => {
    const { engine } = makeEngine();
    const scopes = ["global", "profile", "workspace", "project"] as const;
    const ids: Record<string, string> = {};
    for (const scope of scopes) {
      const dir = await makeSkillDir("shared", { description: `from ${scope}` });
      const skill = await engine.installFromDir(dir, { scope, source: "local" });
      ids[scope] = skill.id;
    }
    const effective = await engine.listEffective();
    const shared = effective.filter((s) => s.name === "shared");
    expect(shared).toHaveLength(1);
    expect(shared[0]?.scope).toBe("project");
    expect(shared[0]?.id).toBe(ids["project"]);

    // Remove the project one: workspace now wins.
    await engine.uninstall(ids["project"] as SkillDefinition["id"]);
    const after = await engine.listEffective();
    expect(after.find((s) => s.name === "shared")?.scope).toBe("workspace");
  });

  it("lists per scope", async () => {
    const { engine } = makeEngine();
    await engine.installFromDir(await makeSkillDir("g"), { scope: "global", source: "local" });
    await engine.installFromDir(await makeSkillDir("p"), { scope: "project", source: "local" });
    expect(await engine.list({ scope: "global" })).toHaveLength(1);
    expect(await engine.list()).toHaveLength(2);
  });
});
