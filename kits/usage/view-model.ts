import type { UsageRow, UsageTokens } from "./protocol.js";

export type UsagePeriod = "today" | "7d" | "30d" | "all";

export const USAGE_PERIODS: ReadonlyArray<{ id: UsagePeriod; label: string }> = [
  { id: "today", label: "Today" },
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
  { id: "all", label: "All time" },
];

/**
 * Where a period starts, at local midnight: today, and the six or twenty-nine
 * days before it. The client's clock decides, so a remote host still counts
 * the user's own day.
 */
export function periodStart(period: UsagePeriod, now: Date = new Date()): number | undefined {
  if (period === "all") return undefined;
  const back = period === "today" ? 0 : period === "7d" ? 6 : 29;
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
      threads: row.threads,
    }));
  }
  const groups = new Map<string, UsageGroup>();
  for (const row of rows) {
    const key = by === "project" ? row.cwd : by === "backend" ? row.backend : row.model;
    let group = groups.get(key);
    if (!group) {
      const label = by === "project" ? row.projectName : by === "backend" ? row.backendLabel : row.model;
      group = { key, label, ...(by === "project" ? { detail: row.cwd } : {}), requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0 };
      groups.set(key, group);
    }
    add(group, row);
  }
  return [...groups.values()].sort((left, right) => right.costUsd - left.costUsd || right.totalTokens - left.totalTokens || left.label.localeCompare(right.label));
}

/** Tokens the way the composer writes them: 842, 12.3k, 1.4M. */
export function formatTokens(tokens: number): string {
  const value = Math.max(0, Math.round(tokens));
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}
