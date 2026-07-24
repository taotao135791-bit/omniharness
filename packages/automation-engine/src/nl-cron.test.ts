import { describe, expect, it } from "vitest";
import { nlToCron } from "./nl-cron.js";
import { parseCron } from "./cron.js";

describe("nlToCron", () => {
  it.each([
    ["every 5 minutes", "*/5 * * * *"],
    ["every minute", "* * * * *"],
    ["every 2 hours", "0 */2 * * *"],
    ["every hour", "0 * * * *"],
    ["hourly", "0 * * * *"],
    ["daily", "0 0 * * *"],
    ["every day at 9am", "0 9 * * *"],
    ["daily at 18:00", "0 18 * * *"],
    ["every day at 9:30pm", "30 21 * * *"],
    ["every day at 12am", "0 0 * * *"],
    ["every day at 12pm", "0 12 * * *"],
    ["weekdays at 18:00", "0 18 * * 1-5"],
    ["every weekday at 9", "0 9 * * 1-5"],
    ["weekends at 10:00", "0 10 * * 0,6"],
    ["weekly", "0 0 * * 1"],
    ["weekly on monday at 9", "0 9 * * 1"],
    ["every friday at 17:30", "30 17 * * 5"],
    ["monthly", "0 0 1 * *"],
    ["Every Day At 9AM", "0 9 * * *"], // case-insensitive
    ["  daily   at   6am ", "0 6 * * *"], // whitespace-tolerant
  ])("maps %j → %j", (phrase, expected) => {
    const cron = nlToCron(phrase);
    expect(cron).toBe(expected);
    // every mapped expression must be a valid cron
    expect(() => parseCron(cron ?? "")).not.toThrow();
  });

  it.each([
    "",
    "sometimes",
    "when it rains",
    "every 5 seconds",
    "every 90 minutes", // out of cron minute-step range
    "every 25 hours",
    "at noon",
    "every day at 25:00",
    "every day at 13pm",
    "next tuesday maybe",
  ])("returns null for %j", (phrase) => {
    expect(nlToCron(phrase)).toBeNull();
  });
});
