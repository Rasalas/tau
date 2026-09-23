/** A provider refused a turn because a usage or rate limit ran out. */
export interface ProviderLimit {
  /** When the limit resets (epoch ms), when the provider said so. */
  resetsAt?: number;
}

/**
 * What providers say when a limit stops a turn: ChatGPT and Codex ("usage
 * limit"), Anthropic (`rate_limit_error`, "usage limit reached"), OpenAI
 * (`insufficient_quota`), OpenCode Go (`GoUsageLimitError`) and plain 429s.
 * A retry Pi already gave up on lands here too, which is the point.
 */
const LIMIT_PATTERN = /usage[ _-]?limit|rate[ _-]?limit|hit your limit|insufficient_quota|quota exceeded|exceeded your current quota|too many requests|\b429\b|UsageLimitError|resource[ _-]?exhausted/iu;

/** Beyond this a reset time is not credible, so none is shown. */
const MAX_WAIT_MS = 30 * 24 * 60 * 60_000;

const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

function unitMs(unit: string): number | undefined {
  const key = unit.toLowerCase();
  if (key.startsWith("sec") || key === "s") return UNIT_MS.s;
  if (key.startsWith("min") || key === "m") return UNIT_MS.m;
  if (key.startsWith("h")) return UNIT_MS.h;
  if (key.startsWith("d")) return UNIT_MS.d;
  return undefined;
}

/** "3:14 PM", "15:14" — the next time the clock shows it. */
function nextClockTime(hours: number, minutes: number, meridiem: string | undefined, now: number): number | undefined {
  let hour = hours;
  if (meridiem) {
    const pm = meridiem.toLowerCase().startsWith("p");
    if (hour < 1 || hour > 12) return undefined;
    hour = (hour % 12) + (pm ? 12 : 0);
  }
  if (hour > 23 || minutes > 59) return undefined;
  const at = new Date(now);
  at.setHours(hour, minutes, 0, 0);
  if (at.getTime() <= now) at.setDate(at.getDate() + 1);
  return at.getTime();
}

/** An epoch in seconds or milliseconds, whichever the number is. */
function fromEpoch(value: number): number {
  return value < 1e12 ? value * 1000 : value;
}

/** The reset time a limit message names, in every spelling providers use. */
export function limitResetTime(message: string, now: number): number | undefined {
  const candidates: Array<number | undefined> = [];
  // "try again in ~42 min", "resets in 2 hours 5 minutes", "retry after 30 seconds"
  const relative = /(?:in|after)\s+~?\s*(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)\b(?:\s*(?:and\s*)?(\d+)\s*(minutes?|mins?|m|seconds?|secs?|s)\b)?/iu.exec(message);
  if (relative) {
    const first = unitMs(relative[2]!);
    const second = relative[4] ? unitMs(relative[4]) : undefined;
    if (first) candidates.push(now + Number(relative[1]) * first + (second && relative[3] ? Number(relative[3]) * second : 0));
  }
  // `"resets_at": 1726000000`, `resetsAt=…`, and the CLI's "limit reached|1726000000"
  const epoch = /(?:resets?_?at["']?\s*[:=]\s*["']?|\|\s*)(\d{10,13})\b/iu.exec(message);
  if (epoch) candidates.push(fromEpoch(Number(epoch[1])));
  // "resets at 2026-09-23T15:14:00Z"
  const iso = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)/u.exec(message);
  if (iso) candidates.push(Date.parse(iso[1]!));
  // "try again at 3:14 PM", "resets 3pm", "resets at 15:14"
  const clock = /(?:again at|resets?(?: at)?)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?/iu.exec(message);
  if (clock && (clock[2] !== undefined || clock[3] !== undefined)) {
    candidates.push(nextClockTime(Number(clock[1]), Number(clock[2] ?? 0), clock[3], now));
  }
  return candidates.find((at): at is number => at !== undefined && Number.isFinite(at) && at > now && at - now <= MAX_WAIT_MS);
}

/** A limit a failed turn's message reports, or `undefined` for any other failure. */
export function detectProviderLimit(message: string | undefined, now = Date.now()): ProviderLimit | undefined {
  if (!message || !LIMIT_PATTERN.test(message)) return undefined;
  const resetsAt = limitResetTime(message, now);
  return resetsAt === undefined ? {} : { resetsAt };
}
