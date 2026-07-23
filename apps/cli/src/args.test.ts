import { describe, expect, it } from "vitest";
import { parseArgs } from "./args.js";

describe("parseArgs", () => {
  it("parses positionals and options", () => {
    const r = parseArgs(["session", "list", "--workspace", "w1", "--json", "--limit=10"]);
    expect(r.positional).toEqual(["session", "list"]);
    expect(r.options).toEqual({ workspace: "w1", json: true, limit: "10" });
  });

  it("handles -- separator", () => {
    const r = parseArgs(["run", "start", "--", "--not-a-flag"]);
    expect(r.positional).toEqual(["run", "start", "--not-a-flag"]);
  });
});
