import type { UsageLimitAccount, UsageLimitSample, UsageLimitWindow } from "./protocol.js";
import { elapsedShare } from "./view-model.js";

const MINUTE = 60_000;
/** Older than this a reading no longer says where a window stands: twice the page's poll. */
export const FRESH_MS = 10 * MINUTE;
/** A forecast looks this far ahead at most; minutes of readings say little about the day after. */
const HORIZON_MS = 120 * MINUTE;
/** Readings further apart than this start a new run: the pace in between is unknown. */
const GAP_MS = 10 * MINUTE;
/** Recent intervals count more; an interval this old counts half. */
const HALF_LIFE_MS = 10 * MINUTE;
/** Above the steady line by more than this many points reads as ahead of it. */
const PACE_BUFFER = 10;
/** Providers' reset times jitter by seconds between reads of one window. */
const RESET_JITTER_MS = MINUTE;

export type QuotaState =
  | { kind: "expired" }
  | { kind: "stale" }
  | { kind: "exhausted" }
  /** Runs out at `at`, before its reset. */
  | { kind: "forecast"; at: number }
  /** Crosses the steady line at `at`. */
  | { kind: "pace"; at: number }
  | { kind: "ahead"; steady: number }
  /** Measured pace lasts until the reset. */
  | { kind: "lasts" }
  | { kind: "steady" }
  | { kind: "unknown" };

/** Where even use over the window would stand now, 0–100, or undefined without a length and reset. */
export function steadyPercent(window: UsageLimitWindow, now: number): number | undefined {
  const share = elapsedShare(window, now);
  return share === undefined || window.resetsAt === undefined || window.resetsAt <= now ? undefined : share * 100;
}

export function isFresh(account: UsageLimitAccount, now: number): boolean {
  const age = now - account.checkedAt;
  return !account.unavailable && age >= -MINUTE && age <= FRESH_MS;
}

/** Readings compare within one source: two runtimes on one account read it at different moments. */
function sameSource(left: UsageLimitAccount, right: UsageLimitAccount): boolean {
  return left.runtime === right.runtime && left.id === right.id && (left.machine ?? "") === (right.machine ?? "");
}

/**
 * Percent per millisecond from the latest run of rising readings of this
 * window and reset, recent intervals weighted more. Undefined without three
 * readings over five minutes, after a drop, or when nothing rose lately.
 */
export function measuredRate(account: UsageLimitAccount, window: UsageLimitWindow, history: readonly UsageLimitSample[], now: number): number | undefined {
  if (!isFresh(account, now) || window.resetsAt === undefined || window.resetsAt <= now || window.usedPercent >= 100) return undefined;
  const values = new Map<number, number>();
  for (const { account: sample } of history) {
    if (sample.unavailable || !sameSource(sample, account) || sample.checkedAt > account.checkedAt || now - sample.checkedAt > 60 * MINUTE) continue;
    const reading = sample.windows.find((entry) => entry.id === window.id && entry.resetsAt !== undefined && Math.abs(entry.resetsAt - window.resetsAt!) <= RESET_JITTER_MS);
    if (reading) values.set(sample.checkedAt, reading.usedPercent);
  }
  values.set(account.checkedAt, window.usedPercent);
  let points = [...values].sort((left, right) => left[0] - right[0]);
  for (let index = points.length - 1; index > 0; index--) {
    if (points[index]![0] - points[index - 1]![0] > GAP_MS) { points = points.slice(index); break; }
  }
  const first = points[0];
  const last = points.at(-1);
  if (points.length < 3 || !first || !last || last[0] - first[0] < 5 * MINUTE || last[1] <= first[1]) return undefined;
  let lastRise = first[0];
  for (let index = 1; index < points.length; index++) {
    if (points[index]![1] < points[index - 1]![1]) return undefined;
    if (points[index]![1] > points[index - 1]![1]) lastRise = points[index]![0];
  }
  if (now - lastRise > GAP_MS) return undefined;
  const decay = Math.LN2 / HALF_LIFE_MS;
  let weighted = 0;
  let total = 0;
  for (let index = 1; index < points.length; index++) {
    const [at, value] = points[index]!;
    const [before, previous] = points[index - 1]!;
    const weight = Math.exp(-(now - at) * decay) * -Math.expm1(-(at - before) * decay);
    weighted += ((value - previous) / (at - before)) * weight;
    total += weight;
  }
  const rate = total > 0 ? weighted / total : 0;
  return rate > 0 && Number.isFinite(rate) ? rate : undefined;
}

/**
 * What a window's reading means now, the most pressing first: a reading past
 * its reset or too old says nothing; then a spent window, a forecast that it
 * runs out or passes the steady line within two hours, being ahead of that
 * line, and a measured pace that lasts to the reset.
 */
export function quotaState(account: UsageLimitAccount, window: UsageLimitWindow, history: readonly UsageLimitSample[], now: number): QuotaState {
  if (window.resetsAt !== undefined && window.resetsAt <= now) return { kind: "expired" };
  if (!isFresh(account, now)) return { kind: "stale" };
  if (window.usedPercent >= 100) return { kind: "exhausted" };
  const steady = steadyPercent(window, now);
  const rate = measuredRate(account, window, history, now);
  const runsOut = rate === undefined ? undefined : now + (100 - window.usedPercent) / rate;
  if (rate !== undefined && runsOut !== undefined) {
    if (runsOut < window.resetsAt! && runsOut - now <= HORIZON_MS) return { kind: "forecast", at: runsOut };
    if (steady !== undefined && steady >= 5 && window.windowMinutes) {
      // The line moves too: only the speed above its own eats the headroom.
      const closing = rate - 100 / (window.windowMinutes * MINUTE);
      const headroom = steady - window.usedPercent;
      const crosses = headroom > 0 && closing > 0 ? now + headroom / closing : undefined;
      if (crosses !== undefined && crosses - now <= HORIZON_MS && crosses < window.resetsAt!) return { kind: "pace", at: crosses };
    }
  }
  if (steady !== undefined && steady >= 5 && window.usedPercent > steady + PACE_BUFFER) return { kind: "ahead", steady };
  if (runsOut !== undefined && runsOut >= window.resetsAt!) return { kind: "lasts" };
  return steady === undefined ? { kind: "unknown" } : { kind: "steady" };
}
