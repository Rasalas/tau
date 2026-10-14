import { describe, expect, it } from "vitest";
import type { UsageTally } from "tau/host-extension";
import { ClaudeUsage, recoverUsageTurns } from "./sdk-usage.js";

const tally = (inputTokens: number, costUsd: number, model = "opus"): UsageTally => ({ provider: "anthropic", model, inputTokens, outputTokens: 10, cacheReadTokens: 1_000, cacheWriteTokens: 20, totalTokens: inputTokens + 1_030, costUsd, turns: 1 });

describe("Claude cumulative usage", () => {
  it("keeps a resume baseline on new CLIs, and starts from zero on older CLIs or a fresh session", () => {
    for (const [version, resumed, expected] of [["2.1.277", true, 5], ["2.1.276", true, 15], ["2.2.0", true, 5], ["2.1.277", false, 15]] as const) {
      const usage = new ClaudeUsage([tally(100, 10)]);
      usage.beginProcess(version, resumed);
      expect(usage.take([tally(150, 15)])[0]?.costUsd).toBe(expected);
    }
  });

  it("preserves a baseline through a zeroed crash result and tracks new models independently", () => {
    const usage = new ClaudeUsage([tally(100, 10)]);
    const zero = { ...tally(0, 0), outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 };
    usage.take([zero]);
    expect(usage.take([tally(150, 15), tally(20, 2, "sonnet")]).map((row) => row.costUsd)).toEqual([5, 2]);
    usage.reset();
    expect(usage.take([tally(10, 1)])[0]?.costUsd).toBe(1);
  });

  it("recovers dated turn deltas without losing the native agents' models or billing", () => {
    const rows = [
      { ...tally(100, 10), at: 1, billing: "subscription" as const },
      { ...tally(20, 2, "sonnet"), at: 1, turns: 0 },
      { ...tally(150, 15), at: 2, billing: "subscription" as const },
      { ...tally(20, 2, "sonnet"), at: 2, turns: 0 },
    ];
    const recovered = recoverUsageTurns(rows);
    expect(recovered.turns.map((row) => row.costUsd)).toEqual([10, 2, 5, 0]);
    expect(recovered.turns[2]).toMatchObject({ at: 2, billing: "subscription", inputTokens: 50, totalTokens: 50 });
    expect(recovered.snapshot.map((row) => row.costUsd)).toEqual([15, 2]);
  });
});
