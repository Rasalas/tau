import type { UsageRow, UsageTokens } from "./protocol.js";

export type UsagePeriod = "today" | "7d" | "30d" | "90d" | "all";

export const USAGE_PERIODS: ReadonlyArray<{ id: UsagePeriod; label: string }> = [
  { id: "today", label: "Today" },
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
  { id: "90d", label: "90 days" },
  { id: "all", label: "All time" },
];

/**
 * Where a period starts, at local midnight, including today's calendar day. The client's clock decides, so a remote host still counts
 * the user's own day.
 */
export function periodStart(period: UsagePeriod, now: Date = new Date()): number | undefined {
  if (period === "all") return undefined;
  const back = period === "today" ? 0 : period === "7d" ? 6 : period === "30d" ? 29 : 89;
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - back).getTime();
}

export type UsageGrouping = "project" | "backend" | "model" | "all";

export const USAGE_GROUPINGS: ReadonlyArray<{ id: UsageGrouping; label: string }> = [
  { id: "project", label: "Project" },
  { id: "backend", label: "Runtime" },
  { id: "model", label: "Model" },
  { id: "all", label: "All three" },
];

export interface UsageGroup extends UsageTokens {
  key: string;
  label: string;
  /** The line under the label: the project's path, or the runtime and model of a row. */
  detail?: string;
  /** What a hover shows when the line is not the whole story. */
  title?: string;
  requests: number;
  /** What the subscription's share would have cost over the API; never part of `costUsd`. */
  apiValueUsd: number;
  /** Tokens a subscription covered. */
  planTokens: number;
  /** Only where one row is one group: a thread that used two models would count twice in a sum. */
  threads?: number;
}

function add(target: UsageGroup, row: UsageRow): void {
  target.requests += row.requests;
  target.inputTokens += row.inputTokens;
  target.outputTokens += row.outputTokens;
  target.cacheReadTokens += row.cacheReadTokens;
  target.cacheWriteTokens += row.cacheWriteTokens;
  target.totalTokens += row.totalTokens;
  target.costUsd += row.costUsd;
  target.apiValueUsd += row.apiValueUsd;
  if (row.billing === "subscription") target.planTokens += row.totalTokens;
}

/** The rows of the table for one grouping, the most expensive first. */
export function groupRows(rows: readonly UsageRow[], by: UsageGrouping): UsageGroup[] {
  if (by === "all") {
    return rows.map((row) => ({
      key: `${row.backend}\u0000${row.cwd}\u0000${row.model}`,
      label: row.projectName,
      detail: `${row.backendLabel} · ${row.model}`,
      title: `${row.backendLabel} · ${row.model} · ${row.cwd}`,
      requests: row.requests,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheReadTokens: row.cacheReadTokens,
      cacheWriteTokens: row.cacheWriteTokens,
      totalTokens: row.totalTokens,
      costUsd: row.costUsd,
      apiValueUsd: row.apiValueUsd,
      planTokens: row.billing === "subscription" ? row.totalTokens : 0,
      threads: row.threads,
    }));
  }
  const groups = new Map<string, UsageGroup>();
  for (const row of rows) {
    const key = by === "project" ? row.cwd : by === "backend" ? row.backend : row.model;
    let group = groups.get(key);
    if (!group) {
      const label = by === "project" ? row.projectName : by === "backend" ? row.backendLabel : row.model;
      group = { key, label, ...(by === "project" ? { detail: row.cwd } : {}), requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0, apiValueUsd: 0, planTokens: 0 };
      groups.set(key, group);
    }
    add(group, row);
  }
  return [...groups.values()].sort((left, right) => (right.costUsd + right.apiValueUsd) - (left.costUsd + left.apiValueUsd) || right.totalTokens - left.totalTokens || left.label.localeCompare(right.label));
}

/** Tokens the way the composer writes them: 842, 12.3k, 1.4M. */
export function formatTokens(tokens: number): string {
  const value = Math.max(0, Math.round(tokens));
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

/** Quota used in a window, rounded and bounded to 0–100. */
export function usedPercent(window: { usedPercent: number }): number {
  return Math.round(Math.max(0, Math.min(100, window.usedPercent)));
}

/** How far into the window the clock is, 0–1, or undefined when its length or reset is unknown. */
export function elapsedShare(window: { resetsAt?: number; windowMinutes?: number }, now: number): number | undefined {
  if (window.resetsAt === undefined || !window.windowMinutes) return undefined;
  const length = window.windowMinutes * 60_000;
  return Math.max(0, Math.min(1, (length - (window.resetsAt - now)) / length));
}

/** `2h 13m`, `3d 4h`, `12m`, as a window's countdown reads. */
export function formatWait(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  const days = Math.floor(minutes / (24 * 60));
  const hours = Math.floor((minutes % (24 * 60)) / 60);
  const rest = minutes % 60;
  if (days > 0) return hours ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return rest ? `${hours}h ${rest}m` : `${hours}h`;
  return `${rest}m`;
}

/** "resets in 2h 13m", or "reset" once the time has passed. */
export function resetsIn(window: { resetsAt?: number }, now: number): string | undefined {
  if (window.resetsAt === undefined) return undefined;
  return window.resetsAt <= now ? "reset" : `resets in ${formatWait(window.resetsAt - now)}`;
}

/** The runtime a limits account and a usage row share: `codex@work` → `codex`, a Pi provider's account → `pi`. */
export function runtimeFamily(runtime: string): string {
  return runtime.split("@")[0] ?? runtime;
}

/**
 * What an account's plan covered in the period: its runtime's subscription
 * rows (for Pi, the provider's), their tokens and what the API would have
 * charged for them.
 */
export function planUsageOf(rows: readonly UsageRow[], account: { runtime: string; id: string }): { tokens: number; requests: number; apiValueUsd: number } {
  const provider = account.runtime === "pi" && account.id.startsWith("pi:") ? account.id.slice(3) : undefined;
  let tokens = 0;
  let requests = 0;
  let apiValueUsd = 0;
  for (const row of rows) {
    if (row.billing !== "subscription" || row.backend !== account.runtime) continue;
    if (provider && row.provider !== provider) continue;
    tokens += row.totalTokens;
    requests += row.requests;
    apiValueUsd += row.apiValueUsd;
  }
  return { tokens, requests, apiValueUsd };
}
