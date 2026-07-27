import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, type OmniDatabase } from "@omniharness/session-store";
import type { ProfileId } from "@omniharness/shared-types";
import {
  AutomationEngine,
  AutomationNotFoundError,
  AutomationValidationError,
  type ProfilePolicy,
} from "./engine.js";
import { makeInput, seedBase } from "./testkit.js";

const T0 = new Date("2024-03-01T09:00:00.000Z");

let db: OmniDatabase;
let engine: AutomationEngine;
let ids: { profileId: ProfileId; workspaceId: ReturnType<typeof seedBase>["workspaceId"] };

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  db = openDatabase(":memory:");
  ids = seedBase(db, T0.toISOString());
  engine = new AutomationEngine({ repo: db.automations });
});

afterEach(() => {
  db.close();
  vi.useRealTimers();
});

describe("AutomationEngine CRUD + scheduling", () => {
  it("creates a cron automation with computed nextRunAt", () => {
    const a = engine.create(
      makeInput(ids, { trigger: { kind: "cron", expression: "0 10 * * *" } }),
    );
    expect(a.id).toMatch(/^auto_/);
    expect(a.nextRunAt).toBe("2024-03-01T10:00:00.000Z");
    expect(engine.get(a.id)?.name).toBe("test automation");
  });

  it("computes nextRunAt in the trigger timezone", () => {
    const a = engine.create(
      makeInput(ids, { trigger: { kind: "cron", expression: "0 9 * * *", timezone: "+01:00" } }),
    );
    expect(a.nextRunAt).toBe("2024-03-02T08:00:00.000Z");
  });

  it("keeps nextRunAt null for event-driven triggers and disabled automations", () => {
    const fileChange = engine.create(
      makeInput(ids, { trigger: { kind: "file_change", pathGlob: "/repo/**/*.md" } }),
    );
    expect(fileChange.nextRunAt).toBeNull();
    const disabled = engine.create(
      makeInput(ids, { enabled: false, trigger: { kind: "cron", expression: "0 10 * * *" } }),
    );
    expect(disabled.nextRunAt).toBeNull();
  });

  it("computes nextRunAt for once triggers and expires past ones", () => {
    const future = engine.create(
      makeInput(ids, { trigger: { kind: "once", at: "2024-03-01T12:00:00.000Z" } }),
    );
    expect(future.nextRunAt).toBe("2024-03-01T12:00:00.000Z");
    const past = engine.create(
      makeInput(ids, { trigger: { kind: "once", at: "2024-03-01T06:00:00.000Z" } }),
    );
    expect(past.nextRunAt).toBeNull();
  });

  it("recomputes nextRunAt on update", () => {
    const a = engine.create(
      makeInput(ids, { trigger: { kind: "cron", expression: "0 10 * * *" } }),
    );
    const updated = engine.update(a.id, { trigger: { kind: "cron", expression: "30 22 * * *" } });
    expect(updated.nextRunAt).toBe("2024-03-01T22:30:00.000Z");
  });

  it("pausing clears nextRunAt, resuming recomputes it", () => {
    const a = engine.create(
      makeInput(ids, { trigger: { kind: "cron", expression: "0 10 * * *" } }),
    );
    const paused = engine.setEnabled(a.id, false);
    expect(paused.enabled).toBe(false);
    expect(paused.nextRunAt).toBeNull();
    const resumed = engine.setEnabled(a.id, true);
    expect(resumed.nextRunAt).toBe("2024-03-01T10:00:00.000Z");
  });

  it("deletes automations", () => {
    const a = engine.create(makeInput(ids));
    expect(engine.delete(a.id)).toBe(true);
    expect(engine.get(a.id)).toBeUndefined();
    expect(() => engine.update(a.id, { name: "x" })).toThrow(AutomationNotFoundError);
  });

  it("rejects invalid input via config-schema validation", () => {
    expect(() => engine.create(makeInput(ids, { name: "" }))).toThrow(AutomationValidationError);
    expect(() => engine.create(makeInput(ids, { timeoutMs: 0 }))).toThrow(
      AutomationValidationError,
    );
  });

  it("rejects invalid cron expressions", () => {
    try {
      engine.create(makeInput(ids, { trigger: { kind: "cron", expression: "61 * * * *" } }));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AutomationValidationError);
      const issues = (err as AutomationValidationError).issues;
      expect(issues.some((i) => i.path === "trigger.expression")).toBe(true);
    }
  });

  it("rejects file_change triggers without a glob", () => {
    expect(() =>
      engine.create(makeInput(ids, { trigger: { kind: "file_change", pathGlob: "  " } })),
    ).toThrow(AutomationValidationError);
  });
});

describe("effectivePermissions", () => {
  const policy: ProfilePolicy = {
    allowedTools: () => ["fs.read"],
    networkAllowed: () => false,
  };

  it("intersects automation tools with the profile policy", () => {
    const restricted = new AutomationEngine({ repo: db.automations, policy });
    const a = restricted.create(makeInput(ids)); // allowedTools: fs.read, shell.exec
    const perms = restricted.effectivePermissions(a);
    expect(perms.tools).toEqual(["fs.read"]);
    expect(perms.networkAllowed).toBe(false); // automation true, policy false → false
  });

  it("never broadens beyond the automation's own list", () => {
    const a = engine.create(makeInput(ids, { allowedTools: ["fs.read"], networkAllowed: false }));
    const perms = engine.effectivePermissions(a); // unrestricted policy
    expect(perms.tools).toEqual(["fs.read"]);
    expect(perms.networkAllowed).toBe(false);
  });
});
