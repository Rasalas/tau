import type { UiThreadUsage } from "../shared/contracts";

/** Tokens as the composer shows them: 842, 12.3k, 1.4M. */
export function formatTokens(tokens: number): string {
  const value = Math.max(0, Math.round(tokens));
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

/**
 * Money, or nothing. A model without pricing bills zero however many tokens it
 * burned, and `$0.00` would read as a fact rather than as a missing price.
 */
export function formatCost(costUsd: number): string | undefined {
  if (!Number.isFinite(costUsd) || costUsd <= 0) return undefined;
  if (costUsd < 0.005) return "<$0.01";
  return `$${costUsd.toFixed(2)}`;
}

/** What a thread has spent, or what it used when nothing priced it. */
export function threadCostLabel(usage: UiThreadUsage | undefined): string | undefined {
  if (!usage) return undefined;
  const cost = formatCost(usage.costUsd);
  if (cost) return cost;
  return usage.totalTokens > 0 ? `${formatTokens(usage.totalTokens)} tok` : undefined;
}

/** The expanded form: "12.3k in · 2.1k out · 8.0k cache read · 3 turns". */
export function threadUsageDetail(usage: UiThreadUsage): string {
  const parts = [`${formatTokens(usage.inputTokens)} in`, `${formatTokens(usage.outputTokens)} out`];
  if (usage.cacheReadTokens > 0) parts.push(`${formatTokens(usage.cacheReadTokens)} cache read`);
  if (usage.cacheWriteTokens > 0) parts.push(`${formatTokens(usage.cacheWriteTokens)} cache write`);
  parts.push(`${usage.turns} ${usage.turns === 1 ? "turn" : "turns"}`);
  return parts.join(" · ");
}
