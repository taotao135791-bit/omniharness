import { describe, expect, it } from "vitest";
import { generateSeatbeltProfile } from "./backends/seatbelt.js";
import type { SandboxRequest } from "./types.js";

function req(overrides: Partial<SandboxRequest> = {}): SandboxRequest {
  return {
    argv: ["echo", "hi"],
    cwd: "/work/dir",
    env: {},
    limits: { timeoutMs: 1000 },
    network: "off",
    writablePaths: ["/work/dir"],
    ...overrides,
  };
}

describe("generateSeatbeltProfile", () => {
  it("denies by default and allows process exec/fork", () => {
    const profile = generateSeatbeltProfile(req());
    expect(profile).toContain("(version 1)");
    expect(profile).toContain("(deny default)");
    expect(profile).toContain("(allow process-exec)");
    expect(profile).toContain("(allow process-fork)");
    expect(profile).toContain("(allow signal (target self))");
  });

  it("allows file-write only under writablePaths", () => {
    const profile = generateSeatbeltProfile(
      req({ writablePaths: ["/work/dir", "/tmp/build"] }),
    );
    expect(profile).toContain('(allow file-write* (subpath "/work/dir"))');
    expect(profile).toContain('(allow file-write* (subpath "/tmp/build"))');
    expect(profile.match(/\(allow file-write\*/g)).toHaveLength(2);
  });

  it("allows file-read everywhere when readOnlyPaths is not provided", () => {
    const profile = generateSeatbeltProfile(req());
    expect(profile).toContain("(allow file-read*)");
    expect(profile).not.toContain("(allow file-read* (subpath");
  });

  it("scopes file-read to readOnlyPaths + cwd when provided", () => {
    const profile = generateSeatbeltProfile(
      req({ readOnlyPaths: ["/usr/lib", "/opt/data"] }),
    );
    expect(profile).toContain('(allow file-read* (subpath "/usr/lib"))');
    expect(profile).toContain('(allow file-read* (subpath "/opt/data"))');
    expect(profile).toContain('(allow file-read* (subpath "/work/dir"))');
    expect(profile).not.toContain("(allow file-read*)\n");
  });

  it("emits no network allow rule when network is off", () => {
    const profile = generateSeatbeltProfile(req({ network: "off" }));
    expect(profile).not.toContain("(allow network");
  });

  it("allows all network when network is all", () => {
    const profile = generateSeatbeltProfile(req({ network: "all" }));
    expect(profile).toContain("(allow network*)");
  });

  it("opens network with a comment for allowlist policy", () => {
    const profile = generateSeatbeltProfile(
      req({ network: "allowlist", allowedDomains: ["api.example.com"] }),
    );
    expect(profile).toContain("(allow network*)");
    expect(profile).toContain("network layer");
    expect(profile).toContain("api.example.com");
  });

  it("escapes quotes and backslashes in paths", () => {
    const profile = generateSeatbeltProfile(
      req({ writablePaths: ['/weird"path', "/back\\slash"] }),
    );
    expect(profile).toContain('(allow file-write* (subpath "/weird\\"path"))');
    expect(profile).toContain('(allow file-write* (subpath "/back\\\\slash"))');
  });
});
