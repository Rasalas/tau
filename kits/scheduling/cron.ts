/**
 * Five-field cron (minute hour day-of-month month day-of-week) in an IANA time
 * zone. Pure: the host computes `nextAt` with it and the renderer previews and
 * describes schedules with the same code.
 */
export interface CronSpec {
  /** Fields joined by single spaces. */
  source: string;
  minutes: number[];
  hours: number[];
  /** Indexed by value: `days[13]`, `months[2]`, `weekdays[0]` (Sunday). */
  days: boolean[];
  months: boolean[];
  weekdays: boolean[];
  /** As Vixie cron: a field that starts with `*` makes day matching AND, otherwise day-of-month OR day-of-week. */
  anyDay: boolean;
  anyWeekday: boolean;
}

export const CRON_MAX_LENGTH = 200;
const FIELDS = [["minute", 0, 59], ["hour", 0, 23], ["day of month", 1, 31], ["month", 1, 12], ["day of week", 0, 7]] as const;
const HOUR = 3_600_000;
const DAY = 86_400_000;
/** Searching further than this answers "never" (`0 0 30 2 *`). */
const HORIZON_DAYS = 5 * 366;

function field(text: string, [name, min, max]: (typeof FIELDS)[number]): boolean[] {
  const values = Array<boolean>(max + 1).fill(false);
  for (const part of text.split(",")) {
    const match = /^(\*|(\d{1,2})(?:-(\d{1,2}))?)(?:\/(\d{1,2}))?$/u.exec(part);
    const from = match?.[2] === undefined ? min : Number(match[2]);
    // `5/15` runs from 5 to the end, as most crons read it.
    const to = match?.[3] !== undefined ? Number(match[3]) : match?.[1] === "*" || match?.[4] !== undefined ? max : from;
    const step = match?.[4] === undefined ? 1 : Number(match[4]);
    if (!match || from < min || to > max || from > to || step < 1 || step > max) throw new Error(`The ${name} field "${part}" isn't valid. Use numbers from ${min} to ${max}: a list like 1,3, a range like 1-5 or a step like */15.`);
    for (let value = from; value <= to; value += step) values[value] = true;
  }
  return values;
}

/** Throws a sentence the editor can show as it is. */
export function parseCron(expression: string): CronSpec {
  if (expression.length > CRON_MAX_LENGTH) throw new Error(`A cron expression is at most ${CRON_MAX_LENGTH} characters.`);
  const parts = expression.trim().split(/\s+/u);
  if (parts.length !== 5 || !parts[0]) throw new Error("A cron expression has five fields: minute, hour, day of month, month and day of week.");
  const [minutes, hours, days, months, weekdays] = parts.map((text, index) => field(text, FIELDS[index]!));
  // 7 is Sunday too.
  if (weekdays![7]) weekdays![0] = true;
  weekdays!.length = 7;
  const list = (values: boolean[]) => values.flatMap((on, value) => on ? [value] : []);
  return { source: parts.join(" "), minutes: list(minutes!), hours: list(hours!), days: days!, months: months!, weekdays: weekdays!, anyDay: parts[2]!.startsWith("*"), anyWeekday: parts[4]!.startsWith("*") };
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timezone: string): Intl.DateTimeFormat {
  let format = formatters.get(timezone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    formatters.set(timezone, format);
  }
  return format;
}
/** The wall clock at `at`, as if it were UTC. */
function wall(at: number, timezone: string): number {
  const parts: Record<string, number> = {};
  for (const part of formatter(timezone).formatToParts(at)) if (part.type !== "literal") parts[part.type] = Number(part.value);
  return Date.UTC(parts.year!, parts.month! - 1, parts.day, parts.hour, parts.minute, parts.second);
}
const offset = (at: number, timezone: string) => wall(at, timezone) - Math.floor(at / 1000) * 1000;

/**
 * The instant a wall-clock time happens in `timezone`: undefined in a
 * spring-forward gap, the first of two in a fall-back hour. Offsets sampled
 * 12 hours either side catch any one transition near it.
 */
export function zonedInstant(local: number, timezone: string): number | undefined {
  const guess = local - offset(local, timezone);
  const offsets = new Set([offset(guess - 12 * HOUR, timezone), offset(guess + 12 * HOUR, timezone)]);
  const found = [...offsets].map((value) => local - value).filter((at) => offset(at, timezone) === local - at);
  return found.length ? Math.min(...found) : undefined;
}

/** Whether `timezone` is an IANA zone this runtime knows. */
export function knownTimeZone(timezone: string): boolean {
  try { formatter(timezone); return true; } catch { return false; }
}

/** Up to `count` run instants after `after` (epoch ms), ascending; empty when nothing matches within five years. */
export function nextRuns(expression: string | CronSpec, timezone: string, after: number, count: number): number[] {
  const spec = typeof expression === "string" ? parseCron(expression) : expression;
  const runs: number[] = [];
  if (!Number.isFinite(after) || count < 1) return runs;
  const start = wall(after, timezone);
  const first = Math.floor(start / DAY) * DAY;
  for (let day = first; day <= first + HORIZON_DAYS * DAY;) {
    const date = new Date(day);
    // Skip a whole month that never matches.
    if (!spec.months[date.getUTCMonth() + 1]) { day = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1); continue; }
    const byDay = spec.days[date.getUTCDate()]!, byWeekday = spec.weekdays[date.getUTCDay()]!;
    if (spec.anyDay || spec.anyWeekday ? byDay && byWeekday : byDay || byWeekday) {
      for (const hour of spec.hours) for (const minute of spec.minutes) {
        const local = day + hour * HOUR + minute * 60_000;
        // A fall-back hour can put a later instant at an earlier wall time, never by three hours.
        if (local < start - 3 * HOUR) continue;
        const at = zonedInstant(local, timezone);
        if (at !== undefined && at > after) { runs.push(at); if (runs.length === count) return runs; }
      }
    }
    day += DAY;
  }
  return runs;
}

/** What the schedule builder shows: one of four shapes, local time. */
export type RepeatRule =
  | { frequency: "hour"; minute: number }
  | { frequency: "day"; time: string }
  | { frequency: "week"; time: string; weekdays: number[] }
  | { frequency: "month"; time: string; day: number };

const pad = (value: number) => String(value).padStart(2, "0");
/** Ascending numbers, three or more in a row as a range: `1-5`, `1,3,5`. */
function compact(values: readonly number[]): string {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let index = 0; index < sorted.length;) {
    let end = index;
    while (end + 1 < sorted.length && sorted[end + 1] === sorted[end]! + 1) end++;
    parts.push(end - index >= 2 ? `${sorted[index]}-${sorted[end]}` : sorted.slice(index, end + 1).join(","));
    index = end + 1;
  }
  return parts.join(",");
}

export function cronFromRule(rule: RepeatRule): string {
  if (rule.frequency === "hour") return `${rule.minute} * * * *`;
  const [hour, minute] = rule.time.split(":").map(Number);
  const prefix = `${minute} ${hour}`;
  if (rule.frequency === "day") return `${prefix} * * *`;
  if (rule.frequency === "week") return `${prefix} * * ${compact(rule.weekdays)}`;
  return `${prefix} ${rule.day} * *`;
}

/** The builder's reading of an expression; undefined for one it cannot show ("Custom"). */
export function ruleFromCron(expression: string): RepeatRule | undefined {
  let spec: CronSpec;
  try { spec = parseCron(expression); } catch { return undefined; }
  const [minute, hour, day, month, weekday] = spec.source.split(" ") as [string, string, string, string, string];
  const single = (text: string) => /^\d+$/u.test(text);
  if (!single(minute) || month !== "*") return undefined;
  if (hour === "*") return day === "*" && weekday === "*" ? { frequency: "hour", minute: Number(minute) } : undefined;
  if (!single(hour)) return undefined;
  const time = `${pad(Number(hour))}:${pad(Number(minute))}`;
  if (day === "*" && weekday === "*") return { frequency: "day", time };
  if (day === "*" && !weekday.startsWith("*")) return { frequency: "week", time, weekdays: spec.weekdays.flatMap((on, value) => on ? [value] : []) };
  if (single(day) && weekday === "*") return { frequency: "month", time, day: Number(day) };
  return undefined;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/** Monday first, as the builder's toggles. */
export const WEEK = [1, 2, 3, 4, 5, 6, 0];
const sentence = (words: string[]) => words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;

/** "Every weekday at 09:00" for the shapes the builder makes; otherwise undefined, and callers show the expression. */
export function describeCron(expression: string): string | undefined {
  const rule = ruleFromCron(expression);
  if (!rule) return undefined;
  if (rule.frequency === "hour") return `Every hour at :${pad(rule.minute)}`;
  if (rule.frequency === "day") return `Every day at ${rule.time}`;
  if (rule.frequency === "month") return `On day ${rule.day} of every month at ${rule.time}`;
  const days = WEEK.filter((day) => rule.weekdays.includes(day));
  if (days.length === 7) return `Every day at ${rule.time}`;
  if (days.join() === "1,2,3,4,5") return `Every weekday at ${rule.time}`;
  return `Every ${sentence(days.map((day) => WEEKDAYS[day]!))} at ${rule.time}`;
}
