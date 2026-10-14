import type { UsageTally, UsageTurn } from "tau/host-extension";

const COUNTS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "costUsd"] as const;
const keyOf = (tally: UsageTally) => `${tally.provider ?? ""}\u0000${tally.model ?? ""}`;

/** A query's modelUsage is cumulative, including its native agents. Only its change is a turn. */
export class ClaudeUsage {
  private previous = new Map<string, UsageTally>();

  constructor(snapshot: readonly UsageTally[] = []) {
    for (const tally of snapshot) this.previous.set(keyOf(tally), { ...tally });
  }

  snapshot(): UsageTally[] { return [...this.previous.values()].map((tally) => ({ ...tally })); }
  reset(): void { this.previous.clear(); }

  /** Before 2.1.277, opening a process started its counters at zero even on resume. */
  beginProcess(version: string | undefined, resumed: boolean): void {
    const parts = version?.match(/^(\d+)\.(\d+)\.(\d+)/u)?.slice(1).map(Number);
    const restores = parts && (parts[0]! > 2 || (parts[0] === 2 && (parts[1]! > 1 || (parts[1] === 1 && parts[2]! >= 277))));
    if (!resumed || !restores) this.reset();
  }

  take(current: readonly UsageTally[]): UsageTally[] {
    return current.map((tally) => {
      const key = keyOf(tally);
      const previous = this.previous.get(key);
      // A crash can report zeroed costs. Keep the last usable snapshot.
      if (tally.totalTokens === 0 && tally.costUsd === 0) return { ...tally };
      this.previous.set(key, { ...tally });
      const delta = { ...tally };
      for (const field of COUNTS) delta[field] = Math.max(0, tally[field] - (previous?.[field] ?? 0));
      delta.totalTokens = delta.inputTokens + delta.outputTokens + delta.cacheReadTokens + delta.cacheWriteTokens;
      return delta;
    });
  }
}

/** Old live records stored SDK snapshots as turns; imports already contain per-response usage. */
export function recoverUsageTurns(turns: readonly UsageTurn[]): { turns: UsageTurn[]; snapshot: UsageTally[] } {
  const usage = new ClaudeUsage();
  const recovered = turns.map((turn) => ({ ...usage.take([turn])[0]!, at: turn.at }));
  return { turns: recovered, snapshot: usage.snapshot() };
}
