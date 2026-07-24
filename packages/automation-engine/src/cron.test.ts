import { describe, expect, it } from "vitest";
import { CronParseError, nextRun, parseCron, resolveTimezoneOffsetMinutes } from "./cron.js";

const d = (iso: string): Date => new Date(iso);
const iso = (date: Date | null): string | null => (date === null ? null : date.toISOString());

describe("parseCron", () => {
  it("parses all standard field forms", () => {
    const s = parseCron("*/15 9-17/2 1,15 1-6 mon-fri");
    expect([...s.minute.values].sort((a, b) => a - b)).toEqual([0, 15, 30, 45]);
    expect([...s.hour.values].sort((a, b) => a - b)).toEqual([9, 11, 13, 15, 17]);
    expect([...s.dayOfMonth.values].sort((a, b) => a - b)).toEqual([1, 15]);
    expect([...s.month.values].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
    expect([...s.dayOfWeek.values].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it("treats 7 as Sunday", () => {
    const s = parseCron("0 0 * * 7");
    expect([...s.dayOfWeek.values]).toEqual([0]);
  });

  it("supports month and weekday names case-insensitively", () => {
    const s = parseCron("0 9 * JAN Mon");
    expect([...s.month.values]).toEqual([1]);
    expect([...s.dayOfWeek.values]).toEqual([1]);
  });

  it("expands a/n as a→max with step n", () => {
    const s = parseCron("5/20 * * * *");
    expect([...s.minute.values].sort((a, b) => a - b)).toEqual([5, 25, 45]);
  });

  it.each([
    ["too few fields", "* * * *"],
    ["too many fields", "* * * * * *"],
    ["minute out of range", "61 * * * *"],
    ["hour out of range", "* 24 * * *"],
    ["dom out of range", "* * 0 * *"],
    ["month out of range", "* * * 13 *"],
    ["dow out of range", "* * * * 8"],
    ["bad step", "*/0 * * * *"],
    ["garbage", "x * * * *"],
    ["inverted range", "* 17-9 * * *"],
    ["empty list item", "0,,9 * * * *"],
  ])("rejects %s", (_label, expr) => {
    expect(() => parseCron(expr)).toThrow(CronParseError);
  });
});

describe("nextRun", () => {
  it.each([
    ["every minute", "* * * * *", "2024-03-01T09:00:30.000Z", "2024-03-01T09:01:00.000Z"],
    ["exactly on a minute fires the next one", "* * * * *", "2024-03-01T09:00:00.000Z", "2024-03-01T09:01:00.000Z"],
    ["step minutes", "*/15 * * * *", "2024-03-01T09:07:00.000Z", "2024-03-01T09:15:00.000Z"],
    ["daily at 9", "0 9 * * *", "2024-03-01T09:00:00.000Z", "2024-03-02T09:00:00.000Z"],
    ["minute list", "0 9,17 * * *", "2024-03-01T10:00:00.000Z", "2024-03-01T17:00:00.000Z"],
    ["hour range with step", "0 9-17/2 * * *", "2024-03-01T10:00:00.000Z", "2024-03-01T11:00:00.000Z"],
    ["weekdays skips weekend", "0 9 * * 1-5", "2024-03-01T10:00:00.000Z", "2024-03-04T09:00:00.000Z"], // Fri → Mon
    ["month rollover", "0 0 1 * *", "2024-01-15T00:00:00.000Z", "2024-02-01T00:00:00.000Z"],
    ["year rollover", "0 0 1 1 *", "2024-06-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z"],
    ["named month/day", "0 9 * jan mon", "2024-03-01T00:00:00.000Z", "2025-01-06T09:00:00.000Z"], // 2025-01-06 is Monday
    ["leap day", "0 0 29 2 *", "2023-03-01T00:00:00.000Z", "2024-02-29T00:00:00.000Z"],
    ["day 31 skips short months", "0 0 31 * *", "2024-04-01T00:00:00.000Z", "2024-05-31T00:00:00.000Z"],
  ])("%s", (_label, expr, after, expected) => {
    expect(iso(nextRun(expr, d(after)))).toBe(expected);
  });

  it("returns null for impossible schedules (Feb 30)", () => {
    expect(nextRun("0 0 30 2 *", d("2024-01-01T00:00:00.000Z"))).toBeNull();
  });

  describe("dom/dow Vixie OR-semantics", () => {
    // Jan 2024: Fri Jan 5, Sat Jan 13. After Mon Jan 1 the next hit of
    // "13th OR Friday" is Friday Jan 5 — dow alone would give the same, but
    // after Jan 6 the OR must produce Sat Jan 13 (not Fri Jan 12's cousin).
    it("both restricted → either matches", () => {
      expect(iso(nextRun("0 0 13 * 5", d("2024-01-01T00:00:00.000Z")))).toBe("2024-01-05T00:00:00.000Z");
      expect(iso(nextRun("0 0 13 * 5", d("2024-01-06T00:00:00.000Z")))).toBe("2024-01-12T00:00:00.000Z"); // next Friday
      expect(iso(nextRun("0 0 13 * 5", d("2024-01-12T00:00:01.000Z")))).toBe("2024-01-13T00:00:00.000Z"); // the 13th
    });

    it("dom restricted, dow * → only the 13th", () => {
      expect(iso(nextRun("0 0 13 * *", d("2024-01-01T00:00:00.000Z")))).toBe("2024-01-13T00:00:00.000Z");
    });

    it("dow restricted, dom * → only Fridays", () => {
      expect(iso(nextRun("0 0 * * 5", d("2024-01-01T00:00:00.000Z")))).toBe("2024-01-05T00:00:00.000Z");
    });
  });

  it("evaluates fields in the given timezone offset", () => {
    // 09:00 at UTC+1 = 08:00Z
    expect(iso(nextRun("0 9 * * *", d("2024-03-01T00:00:00.000Z"), 60))).toBe("2024-03-01T08:00:00.000Z");
    // 09:00 at UTC-5 = 14:00Z
    expect(iso(nextRun("0 9 * * *", d("2024-03-01T00:00:00.000Z"), -300))).toBe("2024-03-01T14:00:00.000Z");
  });

  it("accepts a pre-parsed schedule", () => {
    const s = parseCron("0 9 * * *");
    expect(iso(nextRun(s, d("2024-03-01T10:00:00.000Z")))).toBe("2024-03-02T09:00:00.000Z");
  });
});

describe("resolveTimezoneOffsetMinutes", () => {
  const at = d("2024-03-01T12:00:00.000Z");
  it("handles UTC and fixed offsets", () => {
    expect(resolveTimezoneOffsetMinutes(undefined, at)).toBe(0);
    expect(resolveTimezoneOffsetMinutes("UTC", at)).toBe(0);
    expect(resolveTimezoneOffsetMinutes("+05:30", at)).toBe(330);
    expect(resolveTimezoneOffsetMinutes("UTC-4", at)).toBe(-240);
    expect(resolveTimezoneOffsetMinutes("-0530", at)).toBe(-330);
  });
  it("resolves IANA names via Intl", () => {
    expect(resolveTimezoneOffsetMinutes("America/New_York", at)).toBe(-300); // EST in March 1st 2024
  });
  it("falls back to 0 for unknown zones", () => {
    expect(resolveTimezoneOffsetMinutes("Not/AZone", at)).toBe(0);
  });
});
