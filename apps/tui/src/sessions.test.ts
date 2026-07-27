import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeDaemon } from "./test/fake-daemon.js";
import {
  connectController,
  makeSession,
  registerBaseHandlers,
  sid,
  type TestHarness,
} from "./test/harness.js";

describe("sessions view", () => {
  let daemon: FakeDaemon;
  let harness: TestHarness;

  const sessions = [
    makeSession({
      id: "s1",
      title: "Refactor auth",
      tags: ["backend"],
      updatedAt: "2026-07-22T09:00:00.000Z",
    }),
    makeSession({ id: "s2", title: "Fix flaky test", updatedAt: "2026-07-21T15:00:00.000Z" }),
    makeSession({
      id: "s3",
      title: "Old stuff",
      status: "archived",
      updatedAt: "2026-07-01T10:00:00.000Z",
    }),
  ];

  beforeEach(async () => {
    daemon = await FakeDaemon.start();
    registerBaseHandlers(daemon, sessions);
    harness = await connectController(daemon);
    await harness.controller.refreshSessions(0);
  });

  afterEach(async () => {
    await harness.client.close();
    await daemon.close();
  });

  it("renders the session list from session.list", () => {
    const lines = harness.controller.sessions.renderLines(80, 20);
    const text = lines.join("\n");
    expect(text).toContain("Refactor auth");
    expect(text).toContain("Fix flaky test");
    expect(text).toContain("Old stuff [archived]");
    expect(text).toContain("#backend");
    // first row selected
    expect(lines[0]).toMatch(/^❯/);
  });

  it("create sends session.create; open loads messages and enters chat", async () => {
    const newSession = makeSession({ id: "s9", title: "New" });
    daemon.on("session.create", () => ({ session: newSession }));
    daemon.on("session.get", () => ({ session: newSession }));
    daemon.on("session.messages", () => ({ messages: [] }));

    const created = await harness.controller.createSession("ws-1", "New");
    expect(created.id).toBe("s9");
    expect(daemon.lastCommand("session.create")?.params).toEqual({
      workspaceId: "ws-1",
      title: "New",
    });

    await harness.controller.openSession(sid("s9"));
    expect(harness.controller.view).toBe("chat");
    expect(harness.controller.currentSession?.id).toBe("s9");
    expect(daemon.lastCommand("session.messages")?.params).toMatchObject({ sessionId: "s9" });
  });

  it("rename and archive hit their RPCs", async () => {
    daemon.on("session.rename", (params) => ({
      session: makeSession({ id: params.sessionId as string, title: params.title as string }),
    }));
    daemon.on("session.archive", () => ({ ok: true }));

    await harness.controller.renameSession(sid("s1"), "Renamed");
    expect(daemon.lastCommand("session.rename")?.params).toEqual({
      sessionId: "s1",
      title: "Renamed",
    });

    await harness.controller.archiveSession(sid("s2"));
    expect(daemon.lastCommand("session.archive")?.params).toEqual({ sessionId: "s2" });
  });

  it("selection moves and skips nothing (no headers here)", () => {
    const vm = harness.controller.sessions;
    expect(vm.selectedSession()?.id).toBe("s1");
    vm.list.move(1);
    expect(vm.selectedSession()?.id).toBe("s2");
    vm.list.move(1);
    expect(vm.selectedSession()?.id).toBe("s3");
    vm.list.move(1); // wraps
    expect(vm.selectedSession()?.id).toBe("s1");
  });

  it("list snapshot", () => {
    expect(harness.controller.sessions.renderLines(80, 20)).toMatchSnapshot();
  });
});
