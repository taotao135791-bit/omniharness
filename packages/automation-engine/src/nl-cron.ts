/**
 * Deterministic natural-language → cron mapper for the most common schedule
 * phrases. Returns null when the phrase is not understood — it never guesses.
 *
 * Defaults for bare frequencies: "daily" → midnight, "weekly" → Monday 00:00,
 * "monthly" → the 1st at 00:00, "hourly" → top of the hour.
 */

const DAY_NAMES: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

/** Parse "9", "9am", "9:30pm", "18:00" → [hour, minute], or null. */
function parseTime(
  hRaw: string,
  mRaw: string | undefined,
  meridiem: string | undefined,
): [number, number] | null {
  let hour = Number(hRaw);
  const minute = mRaw === undefined ? 0 : Number(mRaw);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute > 59) return null;
  if (meridiem !== undefined) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === "am") {
      if (hour === 12) hour = 0;
    } else if (hour !== 12) {
      hour += 12;
    }
  } else if (hour > 23) {
    return null;
  }
  return [hour, minute];
}

/** Map a common English schedule phrase to a 5-field cron expression, or null. */
export function nlToCron(input: string): string | null {
  const text = input.toLowerCase().trim().replace(/\s+/g, " ");
  if (text === "") return null;

  if (text === "every minute" || text === "minutely") return "* * * * *";
  if (text === "hourly" || text === "every hour") return "0 * * * *";

  let m = /^every (\d{1,3}) minutes?$/.exec(text);
  if (m !== null) {
    const n = Number(m[1]);
    return n >= 1 && n <= 59 ? `*/${n} * * * *` : null;
  }
  m = /^every (\d{1,2}) hours?$/.exec(text);
  if (m !== null) {
    const n = Number(m[1]);
    return n >= 1 && n <= 23 ? `0 */${n} * * *` : null;
  }

  // Split "<day part> at <time>"; if "at" is present but the time doesn't
  // parse, atMatch is null and the day part won't match either → null.
  const atMatch = /^(.*?)\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(text);
  let hour = 0;
  let minute = 0;
  let dayPart = text;
  if (atMatch !== null) {
    const parsed = parseTime(atMatch[2] ?? "", atMatch[3], atMatch[4]);
    if (parsed === null) return null;
    [hour, minute] = parsed;
    dayPart = (atMatch[1] ?? "").trim();
  }

  const time = `${minute} ${hour}`;
  if (dayPart === "daily" || dayPart === "every day" || dayPart === "everyday") {
    return `${time} * * *`;
  }
  if (dayPart === "weekdays" || dayPart === "every weekday") {
    return `${time} * * 1-5`;
  }
  if (dayPart === "weekends" || dayPart === "every weekend") {
    return `${time} * * 0,6`;
  }
  if (dayPart === "weekly") return `${time} * * 1`;
  if (dayPart === "monthly") return `${time} 1 * *`;

  const dayMatch = /^(?:every\s+|weekly\s+on\s+|on\s+)?([a-z]+)$/.exec(dayPart);
  if (dayMatch !== null) {
    const dow = DAY_NAMES[dayMatch[1] ?? ""];
    if (dow !== undefined) return `${time} * * ${dow}`;
  }
  return null;
}
