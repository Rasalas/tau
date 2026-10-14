import type { UiSession, UiThreadUsage } from "tau";

const FIELDS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens", "costUsd", "turns"] as const;
const empty = (): UiThreadUsage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0, turns: 0 });

function add(total: UiThreadUsage, usage: UiThreadUsage): void {
  for (const field of FIELDS) total[field] += usage[field];
  if (usage.subscription) {
    total.subscription ??= { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, turns: 0, apiValueUsd: 0 };
    for (const field of FIELDS) {
      if (field !== "costUsd") total.subscription[field] += usage.subscription[field];
    }
    total.subscription.apiValueUsd += usage.subscription.apiValueUsd;
  }
}

export function apiValue(usage: UiThreadUsage): number {
  return usage.costUsd + (usage.subscription?.apiValueUsd ?? 0);
}

export interface ThreadCostSummary {
  usage: UiThreadUsage;
  providers: { provider: string; usage: UiThreadUsage }[];
  subagents: number;
}

/** Shells contain each thread's own usage. Native children are already in their runtime's total. */
export function threadCostSummary(id: string, own: UiThreadUsage | undefined, provider: string | undefined, threads: readonly UiSession[], parents: Readonly<Record<string, string>>): ThreadCostSummary {
  const children = new Map<string, UiSession[]>();
  for (const thread of threads) {
    const parent = parents[thread.id] ?? thread.parentThreadId;
    if (parent) children.set(parent, [...children.get(parent) ?? [], thread]);
  }
  const usage = empty();
  const providers = new Map<string, UiThreadUsage>();
  const include = (value: UiThreadUsage | undefined, name = "unknown") => {
    if (!value) return;
    add(usage, value);
    const key = name === "openai-codex" ? "openai" : name;
    let grouped = providers.get(key);
    if (!grouped) providers.set(key, grouped = empty());
    add(grouped, value);
  };
  const root = threads.find((thread) => thread.id === id);
  include(own ?? root?.usage, provider ?? root?.modelProvider);
  const seen = new Set([id]);
  const queue = [id];
  for (let index = 0; index < queue.length; index += 1) {
    for (const child of children.get(queue[index]!) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      queue.push(child.id);
      include(child.usage, child.modelProvider ?? child.machine?.modelProvider);
    }
  }
  return { usage, providers: [...providers].map(([name, grouped]) => ({ provider: name, usage: grouped })), subagents: seen.size - 1 };
}
