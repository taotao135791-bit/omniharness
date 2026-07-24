import { describe, expect, it } from "vitest";
import { DuplicateToolError, ToolRegistry } from "./index.js";
import type { Tool } from "./index.js";

function fakeTool(name: string): Tool {
  return {
    name,
    description: `${name} description`,
    parametersSchema: { type: "object" },
    requiredCapabilities: ["fs.read"],
    async execute() {
      return { ok: true, output: name };
    },
  };
}

describe("ToolRegistry", () => {
  it("registers, looks up and lists tools", () => {
    const reg = new ToolRegistry();
    reg.register(fakeTool("a"));
    reg.registerAll([fakeTool("b"), fakeTool("c")]);

    expect(reg.has("a")).toBe(true);
    expect(reg.get("b")?.name).toBe("b");
    expect(reg.get("missing")).toBeUndefined();

    const list = reg.list();
    expect(list.map((t) => t.name).sort()).toEqual(["a", "b", "c"]);
    expect(list[0]).toHaveProperty("description");
    expect(list[0]).toHaveProperty("requiredCapabilities");
  });

  it("rejects duplicate names", () => {
    const reg = new ToolRegistry();
    reg.register(fakeTool("x"));
    expect(() => reg.register(fakeTool("x"))).toThrow(DuplicateToolError);
  });

  it("unregisters", () => {
    const reg = new ToolRegistry();
    reg.register(fakeTool("x"));
    expect(reg.unregister("x")).toBe(true);
    expect(reg.unregister("x")).toBe(false);
  });
});
