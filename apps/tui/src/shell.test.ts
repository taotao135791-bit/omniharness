import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TUI, type Terminal } from "@earendil-works/pi-tui";
import { FakeDaemon } from "./test/fake-daemon.js";
import { connectController, makeSession, registerBaseHandlers, sid, type TestHarness } from "./test/harness.js";
import { AppShell } from "./shell/app-shell.js";

function stubTerminal(columns = 120, rows = 40): Terminal {
  return {
    start: () => undefined,
    stop: () => undefined,
    drainInput: () => Promise.resolve(),
    write: () => undefined,
    columns,
    rows,
    kittyProtocolActive: false,
    moveBy: () => undefined,
    hideCursor: () => undefined,
    showCursor: () => undefined,
    clearLine: () => undefined,
    clearFromCursor: () => undefined,
    clearScreen: () => undefined,
    setTitle: () => undefined,
    setProgress: () => undefined,
  };
}

describe("app shell", () => {
  let daemon: FakeDaemon;
  let harness: TestHarness;
  let shell: AppShell;

  beforeEach(async () => {
    daemon = await FakeDaemon.start();
    registerBaseHandlers(daemon, [makeSession()]);
    harness = await connectController(daemon);
    await harness.controller.refreshSessions(0);
    const tui = new TUI(stubTerminal());
    shell = new AppShell(tui, harness.controller, "OmniHarness");
  });

  afterEach(async () => {
    await harness.client.close();
    await daemon.close();
  });

  it("renders header + view + status bar at normal width", () => {
    const lines = shell.render(120);
    const text = lines.join("\n");
    expect(text).toContain("OmniHarness");
    expect(text).toContain("Test session");
    expect(text).toContain("Sessions");
  });

  it("collapses chrome below 80 cols without crashing", () => {
    const lines = shell.render(60);
    const text = lines.join("\n");
    expect(text).toContain("OmniHarness");
    expect(text).toContain("Test session");
    expect(text).not.toContain("daemon"); // compact header drops the version
  });

  it("shows a warning below 40 cols", () => {
    const lines = shell.render(30);
    expect(lines.join("\n")).toContain("Terminal too narrow");
  });

  it("renders every view without crashing", async () => {
    daemon.on("diff.get", () => ({ files: [], truncated: false }));
    daemon.on("provider.list", () => ({ providers: [] }));
    daemon.on("model.list", () => ({ models: [] }));
    daemon.on("memory.list", () => ({ memories: [], total: 0 }));
    daemon.on("skill.list", () => ({ skills: [] }));
    daemon.on("skill.proposals", () => ({ proposals: [] }));
    daemon.on("automation.list", () => ({ automations: [] }));
    daemon.on("automation.runs", () => ({ runs: [], total: 0 }));
    daemon.on("system.diagnostics", () => ({
      ok: true,
      checks: [{ name: "db", ok: true, detail: "ok" }],
      platform: { os: "darwin", arch: "arm64", node: "24" },
      dataDir: "/tmp/x",
      dbSizeBytes: 1024,
      eventLogSize: 10,
    }));
    for (const view of ["sessions", "diff", "models", "approvals", "memory", "skills", "automations", "logs", "settings"] as const) {
      await harness.controller.setView(view);
      const lines = shell.render(100);
      expect(lines.length).toBeGreaterThan(1);
      expect(lines.join("\n")).not.toContain("error:");
    }
  });

  it("chat view renders with the editor at narrow and wide widths", async () => {
    daemon.on("session.get", () => ({ session: makeSession() }));
    daemon.on("session.messages", () => ({ messages: [] }));
    await harness.controller.openSession(sid("sess-1"));
    expect(harness.controller.view).toBe("chat");
    expect(shell.render(100).join("\n")).toContain("Test session");
    expect(shell.render(50).length).toBeGreaterThan(1);
  });
});
