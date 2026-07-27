/**
 * Standard 5-field cron parser and next-run calculator.
 *
 * Supported syntax per field: `*`, step form `*` + `/n`, `a`, `a-b`,
 * `a-b/n`, `a/n` (a→max with step), comma lists of any of the above, and
 * 3-letter English names for month (jan–dec) and day-of-week (sun–sat).
 * Day-of-week accepts 0–6 plus 7 as an alias for Sunday.
 *
 * Day-of-month / day-of-week follow Vixie cron OR-semantics: when both
 * fields are restricted (anything other than `*`), a day matches when either
 * field matches; otherwise the restricted field alone decides.
 */

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/** Search horizon: long enough to always reach the next Feb 29. */
const HORIZON_MS = 5 * 366 * DAY_MS;

export class CronParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronParseError";
  }
}

export interface CronField {
  readonly values: ReadonlySet<number>;
  /** True only for a literal `*` (drives dom/dow OR-semantics, Vixie-style). */
  readonly isWildcard: boolean;
}

export interface CronSchedule {
  readonly minute: CronField;
  readonly hour: CronField;
  readonly dayOfMonth: CronField;
  readonly month: CronField;
  readonly dayOfWeek: CronField;
}

const MONTH_NAMES: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const DOW_NAMES: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

function parseValue(raw: string, min: number, max: number, names?: Record<string, number>): number {
  const named = names?.[raw.toLowerCase()];
  if (named !== undefined) return named;
  if (!/^\d+$/.test(raw)) throw new CronParseError(`invalid value: "${raw}"`);
  const n = Number(raw);
  if (n < min || n > max) throw new CronParseError(`value ${n} out of range ${min}-${max}`);
  return n;
}

function parseField(
  spec: string,
  min: number,
  max: number,
  names?: Record<string, number>,
  dowAlias?: number,
): CronField {
  const values = new Set<number>();
  for (const part of spec.split(",")) {
    if (part === "") throw new CronParseError(`empty list item in "${spec}"`);
    const slash = part.indexOf("/");
    const rangePart = slash === -1 ? part : part.slice(0, slash);
    const stepPart = slash === -1 ? undefined : part.slice(slash + 1);
    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart)) throw new CronParseError(`invalid step in "${part}"`);
      step = Number(stepPart);
      if (step < 1) throw new CronParseError(`step must be >= 1 in "${part}"`);
    }
    let lo: number;
    let hi: number;
    if (rangePart === "*") {
      lo = min;
      hi = max;
    } else if (rangePart.includes("-")) {
      const dash = rangePart.indexOf("-");
      lo = parseValue(rangePart.slice(0, dash), min, max, names);
      hi = parseValue(rangePart.slice(dash + 1), min, max, names);
      if (lo > hi) throw new CronParseError(`inverted range in "${part}"`);
    } else {
      lo = parseValue(rangePart, min, max, names);
      // "a/n" means a→max with step n; bare "a" is just a.
      hi = stepPart === undefined ? lo : max;
    }
    for (let v = lo; v <= hi; v += step) {
      values.add(dowAlias !== undefined && v === dowAlias ? 0 : v);
    }
  }
  return { values, isWildcard: spec === "*" };
}

/** Parse a 5-field cron expression. Throws CronParseError on invalid input. */
export function parseCron(expression: string): CronSchedule {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new CronParseError(`expected 5 fields, got ${fields.length}: "${expression}"`);
  }
  const [minute, hour, dom, month, dow] = fields as [string, string, string, string, string];
  return {
    minute: parseField(minute, 0, 59),
    hour: parseField(hour, 0, 23),
    dayOfMonth: parseField(dom, 1, 31),
    month: parseField(month, 1, 12, MONTH_NAMES),
    // 7 is an alias for Sunday (0).
    dayOfWeek: parseField(dow, 0, 7, DOW_NAMES, 7),
  };
}

function dayMatches(s: CronSchedule, dom: number, dow: number): boolean {
  const { dayOfMonth, dayOfWeek } = s;
  if (dayOfMonth.isWildcard && dayOfWeek.isWildcard) return true;
  if (dayOfMonth.isWildcard) return dayOfWeek.values.has(dow);
  if (dayOfWeek.isWildcard) return dayOfMonth.values.has(dom);
  // Vixie OR-semantics: both restricted → either may match.
  return dayOfMonth.values.has(dom) || dayOfWeek.values.has(dow);
}

/**
 * Compute the next fire time strictly after `after`, evaluating cron fields in
 * the local frame shifted by `tzOffsetMinutes` (minutes east of UTC, e.g. 60
 * for UTC+1, -300 for UTC-5). Returns null when no time matches within the
 * search horizon (e.g. `0 0 30 2 *` — February 30th).
 */
export function nextRun(
  schedule: string | CronSchedule,
  after: Date,
  tzOffsetMinutes = 0,
): Date | null {
  const s = typeof schedule === "string" ? parseCron(schedule) : schedule;
  const offsetMs = tzOffsetMinutes * MINUTE_MS;
  // First whole minute strictly after `after`.
  let t = Math.floor(after.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  const limit = t + HORIZON_MS;
  while (t < limit) {
    const local = new Date(t + offsetMs);
    if (!s.month.values.has(local.getUTCMonth() + 1)) {
      // Jump to local midnight on the 1st of next month.
      const nextMonth = Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 1);
      t = nextMonth - offsetMs;
      continue;
    }
    if (!dayMatches(s, local.getUTCDate(), local.getUTCDay())) {
      // Jump to next local midnight.
      const localMidnight = Math.floor((t + offsetMs) / DAY_MS) * DAY_MS;
      t = localMidnight + DAY_MS - offsetMs;
      continue;
    }
    if (!s.hour.values.has(local.getUTCHours())) {
      // Jump to the next local hour.
      t =
        Math.floor((t + offsetMs) / (60 * MINUTE_MS)) * 60 * MINUTE_MS + 60 * MINUTE_MS - offsetMs;
      continue;
    }
    if (!s.minute.values.has(local.getUTCMinutes())) {
      t += MINUTE_MS;
      continue;
    }
    return new Date(t);
  }
  return null;
}

/**
 * Resolve a trigger `timezone` string to an offset in minutes east of UTC.
 * Supports "UTC", fixed offsets ("+05:30", "UTC-4", "-0530"), and IANA names
 * via Intl — for IANA zones the offset is derived at instant `at` and treated
 * as fixed for the search, so schedules crossing a DST transition may drift
 * by the DST delta (documented approximation).
 */
export function resolveTimezoneOffsetMinutes(timezone: string | undefined, at: Date): number {
  if (timezone === undefined) return 0;
  const tz = timezone.trim();
  if (tz === "" || tz.toUpperCase() === "UTC" || tz === "Z") return 0;
  const m = /^(?:UTC)?([+-])(\d{1,2})(?::?(\d{2}))?$/i.exec(tz);
  if (m !== null) {
    const sign = m[1] === "-" ? -1 : 1;
    const hours = Number(m[2]);
    const minutes = m[3] === undefined ? 0 : Number(m[3]);
    if (hours > 14 || minutes > 59) return 0;
    return sign * (hours * 60 + minutes);
  }
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const parts: Record<string, string> = {};
    for (const p of dtf.formatToParts(at)) parts[p.type] = p.value;
    const wallMs = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    );
    return Math.round((wallMs - at.getTime()) / MINUTE_MS);
  } catch {
    return 0;
  }
}
