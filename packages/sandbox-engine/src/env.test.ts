import { describe, expect, it } from "vitest";
import { filterEnv } from "./engine.js";

describe("filterEnv", () => {
  it("strips secret-looking variable names", () => {
    const out = filterEnv({
      AWS_SECRET_KEY: "x",
      API_TOKEN: "y",
      PASSWORD: "z",
      DATABASE_PASSWORD: "w",
      PATH: "/usr/bin",
      HOME: "/home/u",
    });
    expect(out).toEqual({ PATH: "/usr/bin", HOME: "/home/u" });
  });

  it("keeps variables named in the allowlist (exact match)", () => {
    const out = filterEnv(
      { API_TOKEN: "y", OTHER_TOKEN: "z" },
      ["API_TOKEN"],
    );
    expect(out).toEqual({ API_TOKEN: "y" });
  });

  it("matches case-insensitively", () => {
    const out = filterEnv({ my_secret: "1", Api_Key: "2", safe: "3" });
    expect(out).toEqual({ safe: "3" });
  });

  it("handles empty env", () => {
    expect(filterEnv({})).toEqual({});
  });
});
