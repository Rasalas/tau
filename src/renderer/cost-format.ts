import type { UiSubscriptionUsage, UiThreadUsage } from "../shared/contracts";

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

/** Tokens a thread ran on a subscription, or undefined when none did. */
function planUsage(usage: UiThreadUsage): UiSubscriptionUsage | undefined {
  const plan = usage.subscription;
  return plan && (plan.totalTokens > 0 || plan.turns > 0) ? plan : undefined;
}

/**
 * What a thread has spent, or what it used when nothing priced it. A
 * subscription's share is never added to the money: it reads "plan", with
 * what the API would have charged for it.
 */
export function threadCostLabel(usage: UiThreadUsage | undefined): string | undefined {
  if (!usage) return undefined;
  const cost = formatCost(usage.costUsd);
  const plan = planUsage(usage);
  if (cost && plan) return `${cost} + plan`;
  if (cost) return cost;
  if (plan) {
    const value = formatCost(plan.apiValueUsd);
    return value ? `plan ≈${value}` : `plan · ${formatTokens(plan.totalTokens)} tok`;
  }
  return usage.totalTokens > 0 ? `${formatTokens(usage.totalTokens)} tok` : undefined;
}

type TokenSplit = Pick<UiThreadUsage, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "turns">;

function tokenDetail(usage: TokenSplit): string {
  const parts = [`${formatTokens(usage.inputTokens)} in`, `${formatTokens(usage.outputTokens)} out`];
  if (usage.cacheReadTokens > 0) parts.push(`${formatTokens(usage.cacheReadTokens)} cache read`);
  if (usage.cacheWriteTokens > 0) parts.push(`${formatTokens(usage.cacheWriteTokens)} cache write`);
  parts.push(`${usage.turns} ${usage.turns === 1 ? "turn" : "turns"}`);
  return parts.join(" · ");
}

/** The expanded form: "12.3k in · 2.1k out · 8.0k cache read · 3 turns". */
export function threadUsageDetail(usage: UiThreadUsage): string {
  return tokenDetail(usage);
}

export interface ThreadUsageSections {
  /** Tokens billed per token and their money; absent when all of it ran on a plan. */
  billed?: { cost?: string; detail: string };
  /** Tokens a subscription covered and what the API would have charged for them. */
  plan?: { value?: string; detail: string };
}

/** The two halves of a thread's usage, kept apart the way the popover and the Usage page show them. */
export function threadUsageSections(usage: UiThreadUsage): ThreadUsageSections {
  const plan = planUsage(usage);
  if (!plan) {
    const cost = formatCost(usage.costUsd);
    return { billed: { ...(cost ? { cost } : {}), detail: tokenDetail(usage) } };
  }
  const billedSplit: TokenSplit = {
    inputTokens: usage.inputTokens - plan.inputTokens,
    outputTokens: usage.outputTokens - plan.outputTokens,
    cacheReadTokens: usage.cacheReadTokens - plan.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens - plan.cacheWriteTokens,
    turns: usage.turns - plan.turns,
  };
  const value = formatCost(plan.apiValueUsd);
  const cost = formatCost(usage.costUsd);
  const billedTokens = billedSplit.inputTokens + billedSplit.outputTokens + billedSplit.cacheReadTokens + billedSplit.cacheWriteTokens;
  return {
    ...(billedTokens > 0 || cost ? { billed: { ...(cost ? { cost } : {}), detail: tokenDetail(billedSplit) } } : {}),
    plan: { ...(value ? { value } : {}), detail: tokenDetail(plan) },
  };
}

/** Both halves on one line, for a hover: "$0.42: 2.3k in · … · plan: 10.0k in · … ≈$1.50 via the API". */
export function threadUsageSummary(usage: UiThreadUsage): string {
  const sections = threadUsageSections(usage);
  const parts: string[] = [];
  if (sections.billed) parts.push(`${sections.billed.cost && sections.plan ? `${sections.billed.cost}: ` : ""}${sections.billed.detail}`);
  if (sections.plan) parts.push(`plan: ${sections.plan.detail}${sections.plan.value ? `, ≈${sections.plan.value} via the API` : ""}`);
  return parts.join(" · ");
}
