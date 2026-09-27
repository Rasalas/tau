import type { UsageEntry } from "./protocol.js";

/** Days the page reads at once: the longest range it draws. */
export const HISTORY_DAYS = 90;

export type UsageRange = "7d" | "30d" | "90d";
export const USAGE_RANGES: ReadonlyArray<{ id: UsageRange; label: string; days: number }> = [
  { id: "7d", label: "7 days", days: 7 },
  { id: "30d", label: "30 days", days: 30 },
  { id: "90d", label: "90 days", days: 90 },
];

export type UsageMetric = "cost" | "tokens";

/** Local midnights of the last `count` days, the oldest first; today's is last. */
export function dayStarts(count: number, now: Date = new Date()): number[] {
  return Array.from({ length: count }, (_, index) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - (count - 1 - index)).getTime());
}

/** Money billed per token and a plan's value stay apart; tokens and turns count both. */
export interface UsageFigures {
  costUsd: number;
  apiValueUsd: number;
  totalTokens: number;
  requests: number;
  threads: number;
}

function empty(): UsageFigures {
  return { costUsd: 0, apiValueUsd: 0, totalTokens: 0, requests: 0, threads: 0 };
}

function add(into: Omit<UsageFigures, "threads">, entry: UsageEntry): void {
  into.costUsd += entry.costUsd;
  into.apiValueUsd += entry.apiValueUsd;
  into.totalTokens += entry.totalTokens;
  into.requests += entry.requests;
}

/** Everything from `fromDay` on, with the threads it touched. */
export function figuresFrom(entries: readonly UsageEntry[], fromDay: number): UsageFigures {
  const figures = empty();
  const threads = new Set<string>();
  for (const entry of entries) {
    if (entry.day < fromDay) continue;
    add(figures, entry);
    threads.add(`${entry.backend}\u0000${entry.threadId}`);
  }
  figures.threads = threads.size;
  return figures;
}

export interface DayFigures extends Omit<UsageFigures, "threads"> {
  start: number;
}

/** One bar per day from `fromDay`, empty days included. */
export function dailyFigures(entries: readonly UsageEntry[], days: readonly number[], fromDay: number): DayFigures[] {
  const series = days.slice(fromDay).map((start) => ({ start, costUsd: 0, apiValueUsd: 0, totalTokens: 0, requests: 0 }));
  for (const entry of entries) {
    const bar = series[entry.day - fromDay];
    if (bar) add(bar, entry);
  }
  return series;
}

export type UsageRanking = "project" | "model" | "thread";

export interface RankedUsage extends Omit<UsageFigures, "threads"> {
  key: string;
  backend: string;
  cwd: string;
  model: string;
  provider?: string;
  threadId?: string;
}

/** What a ranking orders by: money (billed, then a plan's value) or tokens. */
export function measure(figures: Pick<UsageFigures, "costUsd" | "apiValueUsd" | "totalTokens">, metric: UsageMetric): number {
  return metric === "tokens" ? figures.totalTokens : figures.costUsd + figures.apiValueUsd;
}

/**
 * The projects, models or threads that used the most from `fromDay` on.
 * A model is keyed with its runtime: the same model through Pi and Codex is two rows.
 */
export function rankUsage(entries: readonly UsageEntry[], fromDay: number, by: UsageRanking, metric: UsageMetric, limit: number): RankedUsage[] {
  const ranked = new Map<string, RankedUsage>();
  for (const entry of entries) {
    if (entry.day < fromDay) continue;
    const key = by === "project" ? entry.cwd : by === "model" ? `${entry.backend}\u0000${entry.provider ?? ""}\u0000${entry.modelId ?? entry.model}` : `${entry.backend}\u0000${entry.threadId}`;
    let item = ranked.get(key);
    if (!item) {
      item = {
        key, backend: entry.backend, cwd: entry.cwd, model: entry.modelId ?? entry.model,
        ...(entry.provider ? { provider: entry.provider } : {}),
        ...(by === "thread" ? { threadId: entry.threadId } : {}),
        costUsd: 0, apiValueUsd: 0, totalTokens: 0, requests: 0,
      };
      ranked.set(key, item);
    }
    add(item, entry);
  }
  return [...ranked.values()]
    .filter((item) => measure(item, metric) > 0 || (metric === "cost" && item.totalTokens > 0))
    .sort((left, right) => measure(right, metric) - measure(left, metric) || right.totalTokens - left.totalTokens || left.key.localeCompare(right.key))
    .slice(0, limit);
}

/** A round top for an axis at or above `value`: 1, 2 or 5 times a power of ten. */
export function niceCeiling(value: number): number {
  if (!(value > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 5, 10].find((factor) => factor * power >= value) ?? 10;
  return step * power;
}
