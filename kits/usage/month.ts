import type { UsageEntry } from "./protocol.js";
import type { UsageFigures } from "./dashboard.js";

const DAY = 86_400_000;

/** Local midnight on the first of `now`'s month. */
export function monthStart(now: Date): number {
  return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
}

function figuresBetween(entries: readonly UsageEntry[], from: number, to: number): UsageFigures {
  const figures: UsageFigures = { costUsd: 0, apiValueUsd: 0, totalTokens: 0, requests: 0, threads: 0 };
  const threads = new Set<string>();
  for (const entry of entries) {
    if (entry.day < from || entry.day >= to) continue;
    figures.costUsd += entry.costUsd;
    figures.apiValueUsd += entry.apiValueUsd;
    figures.totalTokens += entry.totalTokens;
    figures.requests += entry.requests;
    threads.add(`${entry.machine ?? ""}\u0000${entry.backend}\u0000${entry.threadId}`);
  }
  figures.threads = threads.size;
  return figures;
}

export interface MonthFigures {
  /** "September". */
  name: string;
  current: UsageFigures;
  /** The month before, up to the same day of it, when the days read reach back that far. */
  previous?: { name: string; figures: UsageFigures };
  /** `current` scaled from the part of the month gone to the whole month; from its third day on. */
  projected?: UsageFigures;
}

/**
 * This month so far from the page's days (`days` are local midnights, the
 * entries index into them), the month before up to the same day, and where
 * this month is headed at its pace so far.
 */
export function monthFigures(entries: readonly UsageEntry[], days: readonly number[], now: Date): MonthFigures {
  const start = monthStart(now);
  const index = (at: number) => { const found = days.findIndex((day) => day >= at); return found === -1 ? days.length : found; };
  const from = index(start);
  const current = figuresBetween(entries, from, days.length);
  const name = now.toLocaleString(undefined, { month: "long" });
  const before = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const beforeLength = new Date(now.getFullYear(), now.getMonth(), 0).getDate();
  const beforeEnd = new Date(before.getFullYear(), before.getMonth(), Math.min(now.getDate(), beforeLength) + 1).getTime();
  const reach = days[0] !== undefined && days[0] <= before.getTime();
  const previousFigures = reach ? figuresBetween(entries, index(before.getTime()), index(beforeEnd)) : undefined;
  const length = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const gone = (now.getTime() - start) / DAY;
  const scale = gone >= 2 && now.getDate() < length ? length / gone : undefined;
  return {
    name,
    current,
    ...(previousFigures && previousFigures.totalTokens > 0 ? { previous: { name: before.toLocaleString(undefined, { month: "long" }), figures: previousFigures } } : {}),
    ...(scale && current.totalTokens > 0 ? {
      projected: {
        costUsd: current.costUsd * scale, apiValueUsd: current.apiValueUsd * scale, totalTokens: current.totalTokens * scale,
        requests: Math.round(current.requests * scale), threads: current.threads,
      },
    } : {}),
  };
}
