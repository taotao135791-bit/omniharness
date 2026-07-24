import type { Capability } from "@omniharness/shared-types";
import { describe, expect, it } from "vitest";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter.js";
import { parseSkillMd, serializeSkillMd } from "./parser.js";

describe("parseFrontmatter", () => {
  it("parses strings, numbers, booleans", () => {
    const fm = parseFrontmatter(
      ['name: my-skill', "version: 1.0.0", 'ratio: 1.5', "enabled: true", 'title: "Hello: World"'].join(
        "\n",
      ),
    );
    expect(fm["name"]).toBe("my-skill");
    expect(fm["version"]).toBe("1.0.0");
    expect(fm["ratio"]).toBe(1.5);
    expect(fm["enabled"]).toBe(true);
    expect(fm["title"]).toBe("Hello: World");
  });

  it("parses inline string arrays", () => {
    const fm = parseFrontmatter('requiredCapabilities: ["fs.read", "shell.exec"]');
    expect(fm["requiredCapabilities"]).toEqual(["fs.read", "shell.exec"]);
  });

  it("parses block string arrays", () => {
    const fm = parseFrontmatter(["dependencies:", "  - foo@1.0.0", "  - bar"].join("\n"));
    expect(fm["dependencies"]).toEqual(["foo@1.0.0", "bar"]);
  });

  it("skips blank lines and comments", () => {
    const fm = parseFrontmatter(["# a comment", "", "name: x"].join("\n"));
    expect(fm).toEqual({ name: "x" });
  });

  it("rejects nested maps", () => {
    expect(() => parseFrontmatter(["outer:", "  inner: x"].join("\n"))).toThrow(/empty value/);
  });

  it("rejects multi-line scalars", () => {
    expect(() => parseFrontmatter("body: |")).toThrow(/unsupported YAML/);
  });

  it("rejects unterminated inline arrays", () => {
    expect(() => parseFrontmatter('deps: ["a", "b"')).toThrow(/unterminated inline array/);
  });

  it("rejects non-string array items", () => {
    expect(() => parseFrontmatter("deps: [1, 2]")).toThrow(/only string items/);
  });

  it("rejects duplicate keys", () => {
    expect(() => parseFrontmatter("name: a\nname: b")).toThrow(/duplicate key/);
  });

  it("rejects anchors and tags", () => {
    expect(() => parseFrontmatter("name: &anchor foo")).toThrow(/unsupported YAML/);
  });
});

describe("serializeFrontmatter", () => {
  it("round-trips the flat subset", () => {
    const fm = {
      name: "my-skill",
      description: "Does a thing: carefully",
      version: "1.0.0",
      requiredCapabilities: ["fs.read"],
    };
    expect(parseFrontmatter(serializeFrontmatter(fm))).toEqual(fm);
  });
});

describe("parseSkillMd", () => {
  it("parses a full SKILL.md document", () => {
    const doc = [
      "---",
      "name: code-review",
      "description: Review diffs.",
      "version: 1.0.0",
      'requiredCapabilities: ["fs.read"]',
      "---",
      "",
      "# Code Review",
      "",
      "Do the review.",
    ].join("\n");
    const parsed = parseSkillMd(doc);
    expect(parsed.name).toBe("code-review");
    expect(parsed.description).toBe("Review diffs.");
    expect(parsed.version).toBe("1.0.0");
    expect(parsed.requiredCapabilities).toEqual(["fs.read"]);
    expect(parsed.dependencies).toEqual([]);
    expect(parsed.body).toContain("# Code Review");
  });

  it("defaults version when absent", () => {
    const doc = "---\nname: x\ndescription: y\n---\n\nbody here";
    expect(parseSkillMd(doc).version).toBe("0.1.0");
  });

  it("rejects missing frontmatter fence", () => {
    expect(() => parseSkillMd("# just markdown")).toThrow(/frontmatter fence/);
  });

  it("rejects unclosed fence", () => {
    expect(() => parseSkillMd("---\nname: x\n")).toThrow(/not closed/);
  });

  it("rejects missing name", () => {
    expect(() => parseSkillMd("---\ndescription: y\n---\n\nbody")).toThrow(/"name"/);
  });

  it("rejects empty body", () => {
    expect(() => parseSkillMd("---\nname: x\ndescription: y\n---\n\n")).toThrow(/body/);
  });

  it("rejects unknown capabilities", () => {
    const doc = '---\nname: x\ndescription: y\nrequiredCapabilities: ["fs.fly"]\n---\n\nbody';
    expect(() => parseSkillMd(doc)).toThrow(/unknown capabilities: fs\.fly/);
  });
});

describe("serializeSkillMd", () => {
  it("round-trips through parseSkillMd", () => {
    const skill = {
      name: "a",
      description: "b",
      version: "2.0.0",
      requiredCapabilities: [] as Capability[],
      dependencies: ["x@1.0.0"],
      body: "# A\n\nDo it.",
    };
    const parsed = parseSkillMd(serializeSkillMd(skill));
    expect(parsed.name).toBe("a");
    expect(parsed.version).toBe("2.0.0");
    expect(parsed.dependencies).toEqual(["x@1.0.0"]);
    expect(parsed.body).toBe("# A\n\nDo it.");
  });
});
