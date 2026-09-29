import { getClientStorage } from "tau";
import type { UsageLimitsSummary, UsageSummary } from "./protocol.js";

/**
 * What the Usage page last read, kept by the client so the page opens with it
 * at once and the fresh answers follow: in memory for this run of the client,
 * in its storage for the next. A summary's `entries` count days by index into
 * the `days` it was asked for; a later day moves them along.
 */
export interface UsageLastState {
  days: readonly number[];
  summary?: UsageSummary;
  limits?: UsageLimitsSummary;
}

const KEY = "tau.usage.last";
/** Characters: the store is shared with the workbench's own caches. */
const MAX_STORED = 1_000_000;
const DAY = 86_400_000;
/** A forecast reads the last hour of readings; the chart gets the rest with the fresh answer. */
const HISTORY_KEPT_MS = 70 * 60_000;

const memory = new Map<string, UsageLastState>();

function keyOf(machine: string | undefined): string {
  return machine ? `${KEY}@${machine}` : KEY;
}

/** The entries of `state` by the days asked for now; days no longer asked for are dropped. */
function onDays(state: UsageLastState, days: readonly number[]): UsageLastState {
  if (!state.summary?.entries || state.days.length === 0 || (state.days.at(-1) === days.at(-1) && state.days.length === days.length)) return state;
  const index = new Map(days.map((start, position) => [start, position]));
  const entries = state.summary.entries.flatMap((entry) => {
    const moved = index.get(state.days[entry.day] ?? Number.NaN);
    return moved === undefined ? [] : [{ ...entry, day: moved }];
  });
  return { ...state, days, summary: { ...state.summary, entries } };
}

/** The last state for the machine the page shows (`undefined`: the window's own), by the days asked for now. */
export function readLastState(machine: string | undefined, days: readonly number[]): UsageLastState | undefined {
  let state = memory.get(keyOf(machine));
  if (!state) {
    try {
      const stored = JSON.parse(getClientStorage()?.get(keyOf(machine)) ?? "null") as UsageLastState | null;
      if (stored && Array.isArray(stored.days)) state = stored;
    } catch {
      state = undefined;
    }
  }
  return state ? onDays(state, days) : undefined;
}

/** Keeps a fresh answer; what the page does not need at first is left out of the stored copy. */
export function saveLastState(machine: string | undefined, next: Partial<UsageLastState> & { days: readonly number[] }): void {
  const key = keyOf(machine);
  const previous = memory.get(key);
  const state: UsageLastState = { ...(previous ? onDays(previous, next.days) : {}), ...next };
  memory.set(key, state);
  const storage = getClientStorage();
  if (!storage) return;
  const summary = state.summary ? { ...state.summary, rows: [] } : undefined;
  const cutoff = (state.limits?.checkedAt ?? 0) - HISTORY_KEPT_MS;
  const limits = state.limits ? { ...state.limits, history: (state.limits.history ?? []).filter((sample) => sample.account.checkedAt >= cutoff) } : undefined;
  let text = JSON.stringify({ days: state.days, ...(summary ? { summary } : {}), ...(limits ? { limits } : {}) });
  if (text.length > MAX_STORED && summary?.entries) {
    // A long history keeps its last month; the calendar fills in with the fresh answer.
    const from = state.days.findIndex((start) => start >= (state.days.at(-1) ?? 0) - 29 * DAY);
    text = JSON.stringify({ days: state.days, summary: { ...summary, entries: summary.entries.filter((entry) => entry.day >= from) }, ...(limits ? { limits } : {}) });
  }
  try {
    if (text.length <= MAX_STORED) storage.set(key, text);
    else storage.remove(key);
  } catch {
    // A full store only costs the next start its head start.
  }
}

/** For tests: nothing read before. */
export function forgetLastState(): void {
  memory.clear();
}
