import { describe, expect, it } from "vitest";
import { classifyAction } from "./sensitive.js";
import type { ComputerAction } from "./types.js";

describe("sensitive action classification", () => {
  it("flags typing into password fields via hint", () => {
    const action: ComputerAction = {
      kind: "type",
      text: "hunter2",
      hint: "type into the password field",
    };
    const result = classifyAction(action);
    expect(result.sensitive).toBe(true);
    expect(result.kinds).toContain("password_field");
  });

  it("flags sending messages", () => {
    const result = classifyAction({
      kind: "click",
      point: { x: 0.5, y: 0.9 },
      hint: "click Send to post the reply",
    });
    expect(result.sensitive).toBe(true);
    expect(result.kinds).toContain("message_send");
  });

  it("flags purchases", () => {
    const result = classifyAction({
      kind: "click",
      point: { x: 0.5, y: 0.5 },
      hint: "confirm checkout and pay",
    });
    expect(result.sensitive).toBe(true);
    expect(result.kinds).toContain("purchase");
  });

  it("flags deletions", () => {
    const result = classifyAction({
      kind: "click",
      point: { x: 0.1, y: 0.1 },
      hint: "press Delete to remove the file",
    });
    expect(result.sensitive).toBe(true);
    expect(result.kinds).toContain("deletion");
  });

  it("always flags secure_fill as credential entry", () => {
    const result = classifyAction({ kind: "secure_fill", secretRef: "github-pat" });
    expect(result.sensitive).toBe(true);
    expect(result.kinds).toContain("credential_entry");
  });

  it("always flags choose_file as file selection", () => {
    const result = classifyAction({ kind: "choose_file", paths: ["/tmp/a.png"] });
    expect(result.sensitive).toBe(true);
    expect(result.kinds).toContain("file_selection");
  });

  it("treats neutral actions as safe", () => {
    const safe: ComputerAction[] = [
      { kind: "mouse_move", point: { x: 0.2, y: 0.2 } },
      { kind: "click", point: { x: 0.3, y: 0.3 } },
      { kind: "scroll", point: { x: 0.5, y: 0.5 }, deltaX: 0, deltaY: 3 },
      { kind: "screenshot" },
      { kind: "wait", ms: 100 },
      { kind: "type", text: "hello world" },
    ];
    for (const action of safe) {
      expect(classifyAction(action).sensitive).toBe(false);
    }
  });

  it("collects multiple kinds when patterns overlap", () => {
    const result = classifyAction({
      kind: "click",
      point: { x: 0.5, y: 0.5 },
      hint: "delete the message and send confirmation",
    });
    expect(result.kinds).toEqual(expect.arrayContaining(["deletion", "message_send"]));
  });
});
