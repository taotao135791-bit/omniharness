import { describe, expect, it } from "vitest";
import { buildDockerArgv, DEFAULT_DOCKER_IMAGE } from "./backends/docker.js";
import type { SandboxRequest } from "./types.js";

function req(overrides: Partial<SandboxRequest> = {}): SandboxRequest {
  return {
    argv: ["make", "test"],
    cwd: "/work",
    env: { PATH: "/usr/bin", CI: "1" },
    limits: { timeoutMs: 1000 },
    network: "off",
    writablePaths: ["/work"],
    ...overrides,
  };
}

describe("buildDockerArgv", () => {
  it("uses --network none when network is off", () => {
    const argv = buildDockerArgv(req({ network: "off" }), DEFAULT_DOCKER_IMAGE);
    expect(argv).toContain("--network");
    expect(argv[argv.indexOf("--network") + 1]).toBe("none");
  });

  it("uses --network bridge for allowlist and all", () => {
    for (const network of ["allowlist", "all"] as const) {
      const argv = buildDockerArgv(req({ network }), DEFAULT_DOCKER_IMAGE);
      expect(argv[argv.indexOf("--network") + 1]).toBe("bridge");
    }
  });

  it("drops capabilities and sets no-new-privileges", () => {
    const argv = buildDockerArgv(req(), DEFAULT_DOCKER_IMAGE);
    expect(argv.join(" ")).toContain("--cap-drop ALL");
    expect(argv.join(" ")).toContain("--security-opt no-new-privileges");
  });

  it("mounts readOnlyPaths ro and writablePaths rw", () => {
    const argv = buildDockerArgv(
      req({ readOnlyPaths: ["/data"], writablePaths: ["/work"] }),
      DEFAULT_DOCKER_IMAGE,
    );
    expect(argv).toContain("/data:/data:ro");
    expect(argv).toContain("/work:/work:rw");
  });

  it("applies memory and cpu limits when set", () => {
    const argv = buildDockerArgv(
      req({ limits: { timeoutMs: 1000, memoryMb: 512, cpuPercent: 150 } }),
      DEFAULT_DOCKER_IMAGE,
    );
    expect(argv[argv.indexOf("--memory") + 1]).toBe("512m");
    expect(argv[argv.indexOf("--cpus") + 1]).toBe("1.5");
  });

  it("omits resource flags when limits are not set", () => {
    const argv = buildDockerArgv(req(), DEFAULT_DOCKER_IMAGE);
    expect(argv).not.toContain("--memory");
    expect(argv).not.toContain("--cpus");
  });

  it("passes env by name, sets workdir, and ends with image + argv", () => {
    const argv = buildDockerArgv(req(), "my-image:1");
    expect(argv[argv.indexOf("-w") + 1]).toBe("/work");
    const envKeys = argv.flatMap((arg, i) => (arg === "-e" ? [argv[i + 1]] : []));
    expect(envKeys).toEqual(["PATH", "CI"]);
    expect(argv.slice(-3)).toEqual(["my-image:1", "make", "test"]);
  });

  it("starts with docker run --rm -i", () => {
    const argv = buildDockerArgv(req(), DEFAULT_DOCKER_IMAGE);
    expect(argv.slice(0, 4)).toEqual(["docker", "run", "--rm", "-i"]);
  });
});
