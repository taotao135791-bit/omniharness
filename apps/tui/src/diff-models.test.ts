import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeDaemon } from "./test/fake-daemon.js";
import {
  connectController,
  makeDiff,
  makeModel,
  makeProvider,
  makeSession,
  registerBaseHandlers,
  sid,
  type TestHarness,
} from "./test/harness.js";

describe("diff view", () => {
  let daemon: FakeDaemon;
  let harness: TestHarness;
  const session = makeSession();

  beforeEach(async () => {
    daemon = await FakeDaemon.start();
    registerBaseHandlers(daemon, [session]);
    daemon.on("session.get", () => ({ session }));
    daemon.on("session.messages", () => ({ messages: [] }));
    daemon.on("diff.get", () => makeDiff());
    daemon.on("diff.accept", () => ({ ok: true }));
    daemon.on("diff.reject", () => ({ ok: true }));
    harness = await connectController(daemon);
    await harness.controller.openSession(sid("sess-1"));
    await harness.controller.loadDiff();
  });

  afterEach(async () => {
    await harness.client.close();
    await daemon.close();
  });

  it("renders file list with +/- counts", () => {
    const text = harness.controller.diff.renderLines(100, 20).join("\n");
    expect(text).toContain("M src/foo.ts");
    expect(text).toContain("+3 -1");
    expect(text).toContain("A src/bar.ts");
  });

  it("enter expands a file into hunks; hunk accept sends diff.accept with hunkIndex", async () => {
    const vm = harness.controller.diff;
    vm.toggleSelected(); // expand src/foo.ts
    const text = vm.renderLines(100, 20).join("\n");
    expect(text).toContain("hunk 0");
    expect(text).toContain("hunk 1");

    vm.list.selectById("h:src/foo.ts:1");
    const target = vm.selectedTarget();
    expect(target).toEqual({ file: "src/foo.ts", hunkIndex: 1 });

    await harness.controller.diffResolve("accept", target!);
    expect(daemon.lastCommand("diff.accept")?.params).toEqual({
      sessionId: sid("sess-1"),
      file: "src/foo.ts",
      hunkIndex: 1,
    });
    // optimistic state updated
    const hunk = vm.files[0]?.hunks.find((h) => h.index === 1);
    expect(hunk?.accepted).toBe(true);
  });

  it("bulk accept-all sends diff.accept without file", async () => {
    await harness.controller.diffResolve("accept", "all");
    expect(daemon.lastCommand("diff.accept")?.params).toEqual({ sessionId: "sess-1" });
    expect(harness.controller.diff.files.every((f) => f.hunks.every((h) => h.accepted === true))).toBe(
      true,
    );
  });

  it("diff snapshot", () => {
    const vm = harness.controller.diff;
    vm.toggleSelected();
    expect(vm.renderLines(100, 20)).toMatchSnapshot();
  });
});

describe("models view", () => {
  let daemon: FakeDaemon;
  let harness: TestHarness;

  beforeEach(async () => {
    daemon = await FakeDaemon.start();
    registerBaseHandlers(daemon, []);
    daemon.on("provider.list", () => ({
      providers: [makeProvider({ id: "p1", displayName: "OpenAI" }), makeProvider({ id: "p2", kind: "ollama", displayName: "Ollama" })],
    }));
    daemon.on("model.list", () => ({
      models: [
        makeModel({ id: "m1", providerId: "p1", displayName: "GPT-5" }),
        makeModel({ id: "m2", providerId: "p2", displayName: "Llama", capabilities: { ...makeModel().capabilities, vision: false } }),
      ],
    }));
    daemon.on("model.getRoleBindings", () => ({ bindings: { primary: "m1" } }));
    daemon.on("model.setRoleBinding", () => ({ ok: true }));
    daemon.on("provider.test", () => ({ ok: true, latencyMs: 123, models: ["m1"] }));
    harness = await connectController(daemon);
    await harness.controller.loadModels();
  });

  afterEach(async () => {
    await harness.client.close();
    await daemon.close();
  });

  it("groups models by provider with capability badges", () => {
    const text = harness.controller.models.renderLines(100, 30).join("\n");
    expect(text).toContain("OpenAI (openai)");
    expect(text).toContain("Ollama (ollama)");
    expect(text).toContain("GPT-5");
    expect(text).toContain("vision tools");
    expect(text).toContain("128k ctx".replace(" ", "")); // badges join without extra space
    // primary binding shown with star and in bindings header
    expect(text).toContain("★ GPT-5");
    expect(text).toContain("primary");
  });

  it("setRoleBinding primary hits model.setRoleBinding", async () => {
    await harness.controller.setRoleBinding("primary", "m2");
    expect(daemon.lastCommand("model.setRoleBinding")?.params).toMatchObject({
      role: "primary",
      modelId: "m2",
      scope: "profile",
    });
    expect(harness.controller.primaryModelId).toBe("m2");
  });

  it("provider.test renders the result line", async () => {
    await harness.controller.testProvider("p1");
    expect(daemon.lastCommand("provider.test")?.params).toEqual({ providerId: "p1" });
    expect(harness.controller.models.statusLine).toContain("123ms");
  });
});
