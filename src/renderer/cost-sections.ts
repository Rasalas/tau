import type { UiThreadUsage } from "../shared/contracts";
import { formatCost, planUsage, threadUsageDetail } from "./cost-format";

type TokenSplit = Parameters<typeof threadUsageDetail>[0];
const SPLIT = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "turns"] as const;

export interface ThreadUsageSections {
  /** Tokens billed per token and their money; absent when all of it ran on a plan. */
  billed?: { cost?: string; detail: string };
  /** Tokens a subscription covered and what the API would have charged for them. */
  plan?: { value?: string; detail: string };
}

/** The two halves of a thread's usage, kept apart the way the popover and the Usage page show them. */
export function threadUsageSections(usage: UiThreadUsage): ThreadUsageSections {
  const plan = planUsage(usage);
  const cost = formatCost(usage.costUsd);
  if (!plan) return { billed: { ...(cost ? { cost } : {}), detail: threadUsageDetail(usage) } };
  const billed = Object.fromEntries(SPLIT.map((field) => [field, usage[field] - plan[field]])) as TokenSplit;
  const value = formatCost(plan.apiValueUsd);
  const billedTokens = billed.inputTokens + billed.outputTokens + billed.cacheReadTokens + billed.cacheWriteTokens;
  return {
    ...(billedTokens > 0 || cost ? { billed: { ...(cost ? { cost } : {}), detail: threadUsageDetail(billed) } } : {}),
    plan: { ...(value ? { value } : {}), detail: threadUsageDetail(plan) },
  };
}
