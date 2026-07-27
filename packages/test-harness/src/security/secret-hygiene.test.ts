import { describe, expect, it } from "vitest";
import { filterEnv } from "@omniharness/sandbox-engine";
import { redact } from "@omniharness/observability";

/**
 * Security test: secret handling — env filtering and log redaction.
 */
describe("secret hygiene", () => {
  it("sandbox strips secret-looking env vars", () => {
    const env = filterEnv({
      PATH: "/usr/bin",
      OPENAI_API_KEY: "sk-test-123",
      GH_TOKEN: "ghp_abc",
      MY_SECRET: "x",
      DB_PASSWORD: "y",
      NORMAL_VAR: "ok",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.NORMAL_VAR).toBe("ok");
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.MY_SECRET).toBeUndefined();
    expect(env.DB_PASSWORD).toBeUndefined();
  });

  it("logger redaction strips keys and tokens", () => {
    expect(redact("failed with OPENAI_API_KEY=sk-abcdef123456")).not.toContain("sk-abcdef123456");
    expect(redact("Bearer eyJhbGciOiJIUzI1NiJ9.payload")).not.toContain("eyJhbGciOiJIUzI1NiJ9");
  });
});
