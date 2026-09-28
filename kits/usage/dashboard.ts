import type { UsageEntry } from "./protocol.js";
import { toneOf, type UsageTone } from "./tones.js";

/** Days the page reads at once: the longest range it draws. */
export const HISTORY_DAYS = 90;

export type UsageRange = "7d" | "30d" | "90d";
export const USAGE_RANGES: ReadonlyArray<{ id: UsageRange; label: string; days: number }> = [
  { id: "7d", label: "7 days", days: 7 },
  { id: "30d", label: "30 days", days: 30 },
  { id: "90d", label: "90 days", days: 90 },
];

export type UsageMetric = "cost" | "tokens" | "turns";

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

/** One provider's share of a day or a ranked row, by its colour: a model's provider, else its runtime's. */
export interface ProviderPart extends Omit<UsageFigures, "threads"> {
  tone: UsageTone;
}

export interface DayFigures extends Omit<UsageFigures, "threads"> {
  start: number;
  /** In `TONE_ORDER`. */
  parts: ProviderPart[];
}

/** Parts stack in this order, the same in every bar. */
export const TONE_ORDER: readonly UsageTone[] = ["openai", "anthropic", "google", "pi", "other"];

export function toneOfEntry(entry: Pick<UsageEntry, "provider" | "backend">): UsageTone {
  return toneOf(entry.provider ?? entry.backend);
}

function addPart(parts: ProviderPart[], entry: UsageEntry): void {
  const tone = toneOfEntry(entry);
  let part = parts.find((item) => item.tone === tone);
  if (!part) { part = { tone, costUsd: 0, apiValueUsd: 0, totalTokens: 0, requests: 0 }; parts.push(part); }
  add(part, entry);
}

function ordered(parts: ProviderPart[]): ProviderPart[] {
  return parts.sort((left, right) => TONE_ORDER.indexOf(left.tone) - TONE_ORDER.indexOf(right.tone));
}

/** One bar per day from `fromDay`, empty days included. */
export function dailyFigures(entries: readonly UsageEntry[], days: readonly number[], fromDay: number): DayFigures[] {
  const series: DayFigures[] = days.slice(fromDay).map((start) => ({ start, costUsd: 0, apiValueUsd: 0, totalTokens: 0, requests: 0, parts: [] }));
  for (const entry of entries) {
    const bar = series[entry.day - fromDay];
    if (bar) { add(bar, entry); addPart(bar.parts, entry); }
  }
  for (const bar of series) ordered(bar.parts);
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
  /** Another machine's host id, for a project or a thread there. */
  machine?: string;
  parts: ProviderPart[];
}

/** What a ranking orders by: money (billed, then a plan's value), tokens or turns. */
export function measure(figures: Pick<UsageFigures, "costUsd" | "apiValueUsd" | "totalTokens" | "requests">, metric: UsageMetric): number {
  return metric === "tokens" ? figures.totalTokens : metric === "turns" ? figures.requests : figures.costUsd + figures.apiValueUsd;
}

/** One runtime's entries, or all of them; one machine's (`""` this one), or every machine's. */
export function ofRuntime(entries: readonly UsageEntry[], backend: string | undefined, machine?: string): readonly UsageEntry[] {
  return backend || machine !== undefined ? entries.filter((entry) => (!backend || entry.backend === backend) && (machine === undefined || (entry.machine ?? "") === machine)) : entries;
}

/** Runtimes that recorded anything, the busiest first. */
export function runtimesOf(entries: readonly UsageEntry[]): string[] {
  const turns = new Map<string, number>();
  for (const entry of entries) turns.set(entry.backend, (turns.get(entry.backend) ?? 0) + entry.requests);
  return [...turns].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).map(([backend]) => backend);
}

/** Turns per day index, for the activity calendar. */
export function turnsPerDay(entries: readonly UsageEntry[], count: number): number[] {
  const turns = Array.from({ length: count }, () => 0);
  for (const entry of entries) if (entry.day >= 0 && entry.day < count) turns[entry.day]! += entry.requests;
  return turns;
}

/**
 * The projects, models or threads that used the most from `fromDay` on.
 * A model is keyed with its runtime: the same model through Pi and Codex is two rows.
 */
export function rankUsage(entries: readonly UsageEntry[], fromDay: number, by: UsageRanking, metric: UsageMetric, limit: number): RankedUsage[] {
  const ranked = new Map<string, RankedUsage>();
  for (const entry of entries) {
    if (entry.day < fromDay) continue;
    const where = entry.machine ?? "";
    const key = by === "project" ? `${where}\u0000${entry.cwd}` : by === "model" ? `${entry.backend}\u0000${entry.provider ?? ""}\u0000${entry.modelId ?? entry.model}` : `${where}\u0000${entry.backend}\u0000${entry.threadId}`;
    let item = ranked.get(key);
    if (!item) {
      item = {
        key, backend: entry.backend, cwd: entry.cwd, model: entry.modelId ?? entry.model,
        ...(entry.provider ? { provider: entry.provider } : {}),
        ...(by === "thread" ? { threadId: entry.threadId } : {}),
        ...(by !== "model" && entry.machine ? { machine: entry.machine } : {}),
        costUsd: 0, apiValueUsd: 0, totalTokens: 0, requests: 0, parts: [],
      };
      ranked.set(key, item);
    }
    add(item, entry);
    addPart(item.parts, entry);
  }
  for (const item of ranked.values()) ordered(item.parts);
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
