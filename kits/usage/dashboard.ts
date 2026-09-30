import type { UsageEntry } from "./protocol.js";
import { toneOf, type UsageTone } from "./tones.js";

/** Days the page reads at once: the longest range it draws. */
export const HISTORY_DAYS = 90;

/** This month so far, the last 30 days, or everything a host kept (the days before the page's own read as one, day -1). */
export type UsageRange = "month" | "30d" | "all";

/** The first day index a period counts from; -1 takes in what came before the days read. */
export function periodFrom(range: UsageRange, days: readonly number[], now: Date = new Date()): number {
  if (range === "all") return -1;
  if (range === "30d") return Math.max(0, days.length - 30);
  const start = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const index = days.findIndex((day) => day >= start);
  return index === -1 ? days.length : index;
}

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

function add(into: Omit<UsageFigures, "threads">, entry: UsageEntry): void {
  into.costUsd += entry.costUsd;
  into.apiValueUsd += entry.apiValueUsd;
  into.totalTokens += entry.totalTokens;
  into.requests += entry.requests;
}

export interface DayFigures extends Omit<UsageFigures, "threads"> {
  start: number;
  /** What a plan covered: its tokens and turns (its money is `apiValueUsd`). */
  planTokens: number;
  planRequests: number;
}

/** Whether a subscription paid for it, rather than a key per token or a local model. */
export function onPlan(entry: Pick<UsageEntry, "billing" | "apiValueUsd">): boolean {
  return entry.billing === "subscription" || entry.apiValueUsd > 0;
}

export function toneOfEntry(entry: Pick<UsageEntry, "provider" | "backend">): UsageTone {
  return toneOf(entry.provider ?? entry.backend);
}

/** One bar per day from `fromDay`, empty days included. */
export function dailyFigures(entries: readonly UsageEntry[], days: readonly number[], fromDay: number): DayFigures[] {
  const series: DayFigures[] = days.slice(fromDay).map((start) => ({ start, costUsd: 0, apiValueUsd: 0, totalTokens: 0, requests: 0, planTokens: 0, planRequests: 0 }));
  for (const entry of entries) {
    const bar = series[entry.day - fromDay];
    if (!bar) continue;
    add(bar, entry);
    if (onPlan(entry)) { bar.planTokens += entry.totalTokens; bar.planRequests += entry.requests; }
  }
  return series;
}

export type UsageRanking = "project" | "model" | "thread" | "provider";

/** A runtime's provider, for a turn that does not name its model's. */
const RUNTIME_PROVIDERS: Record<string, string> = { "claude-code": "anthropic", codex: "openai", antigravity: "google", grok: "xai", cursor: "cursor", opencode: "opencode" };

/** Who answered: a model's provider, one name per company (`openai-codex` is OpenAI), else its runtime's. */
export function providerOf(entry: Pick<UsageEntry, "provider" | "backend">): string {
  const name = (entry.provider ?? RUNTIME_PROVIDERS[entry.backend.split("@")[0]!] ?? entry.backend).toLowerCase();
  const tone = toneOf(name);
  return tone === "other" || tone === "pi" ? name : tone;
}
export interface RankedUsage extends Omit<UsageFigures, "threads"> {
  key: string;
  backend: string;
  cwd: string;
  model: string;
  provider?: string;
  threadId?: string;
  /** Another machine's host id, for a project or a thread there. */
  machine?: string;
  /** Whether its work ran in Tau, outside it (a CLI on its own), or both. */
  origin: UsageOrigin | "both";
  /** The threads (and outside sessions) it counts. */
  threads: number;
}

/** Work Tau ran, or work a CLI logged on its own. */
export type UsageOrigin = "tau" | "outside";

export function originOf(entry: Pick<UsageEntry, "outside">): UsageOrigin {
  return entry.outside ? "outside" : "tau";
}

/** What a ranking orders by: money (billed, then a plan's value), tokens or turns. */
export function measure(figures: Pick<UsageFigures, "costUsd" | "apiValueUsd" | "totalTokens" | "requests">, metric: UsageMetric): number {
  return metric === "tokens" ? figures.totalTokens : metric === "turns" ? figures.requests : figures.costUsd + figures.apiValueUsd;
}

/** One runtime's entries, or all of them; one machine's (`""` this one), or every machine's; Tau's, outside Tau, or both. */
export function ofRuntime(entries: readonly UsageEntry[], backend: string | undefined, machine?: string, origin?: UsageOrigin): readonly UsageEntry[] {
  if (!backend && machine === undefined && !origin) return entries;
  return entries.filter((entry) => (!backend || entry.backend === backend) && (machine === undefined || (entry.machine ?? "") === machine) && (!origin || originOf(entry) === origin));
}

/** Runtimes that recorded anything, the busiest first. */
export function runtimesOf(entries: readonly UsageEntry[]): string[] {
  const turns = new Map<string, number>();
  for (const entry of entries) turns.set(entry.backend, (turns.get(entry.backend) ?? 0) + entry.requests);
  return [...turns].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).map(([backend]) => backend);
}

/**
 * The projects, models or threads that used the most from `fromDay` on.
 * A model is keyed with its runtime: the same model through Pi and Codex is two rows.
 */
export function rankUsage(entries: readonly UsageEntry[], fromDay: number, by: UsageRanking, metric: UsageMetric, limit: number, projectOf?: (entry: UsageEntry) => string): RankedUsage[] {
  const ranked = new Map<string, RankedUsage>();
  const threads = new Map<string, Set<string>>();
  for (const entry of entries) {
    if (entry.day < fromDay) continue;
    const where = entry.machine ?? "";
    const thread = `${where}\u0000${entry.backend}\u0000${entry.threadId}`;
    const key = by === "project" ? `${where}\u0000${projectOf?.(entry) ?? entry.cwd}` : by === "model" ? `${entry.backend}\u0000${entry.provider ?? ""}\u0000${entry.modelId ?? entry.model}` : by === "provider" ? providerOf(entry) : thread;
    let item = ranked.get(key);
    if (!item) {
      item = {
        key, backend: entry.backend, cwd: entry.cwd, model: entry.modelId ?? entry.model,
        ...(entry.provider ? { provider: entry.provider } : {}),
        ...(by === "thread" ? { threadId: entry.threadId } : {}),
        ...(by !== "model" && entry.machine ? { machine: entry.machine } : {}),
        ...(by === "provider" ? { provider: key } : {}),
        origin: originOf(entry),
        costUsd: 0, apiValueUsd: 0, totalTokens: 0, requests: 0, threads: 0,
      };
      ranked.set(key, item);
      threads.set(key, new Set());
    } else if (item.origin !== originOf(entry)) {
      item.origin = "both";
    }
    threads.get(key)!.add(thread);
    item.threads = threads.get(key)!.size;
    add(item, entry);
  }
  return [...ranked.values()]
    .filter((item) => measure(item, metric) > 0 || (metric === "cost" && item.totalTokens > 0))
    .sort((left, right) => measure(right, metric) - measure(left, metric) || right.totalTokens - left.totalTokens || left.key.localeCompare(right.key))
    .slice(0, limit);
}
