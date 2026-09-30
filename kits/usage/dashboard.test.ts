import { describe, expect, it } from "vitest";
import { dailyFigures, dayStarts, periodFrom, providerOf, rankUsage } from "./dashboard.js";
import type { UsageEntry } from "./protocol.js";

function entry(patch: Partial<UsageEntry>): UsageEntry {
  return {
    day: 0, backend: "pi", threadId: "t1", cwd: "/work/alpha", model: "anthropic/claude-sonnet-4-5", provider: "anthropic", modelId: "claude-sonnet-4-5",
    requests: 1, inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 110, costUsd: 0, apiValueUsd: 0,
    ...patch,
  };
}

const entries: UsageEntry[] = [
  entry({ day: 0, costUsd: 1, totalTokens: 1_000 }),
  entry({ day: 5, threadId: "t2", cwd: "/work/beta", costUsd: 0.5, totalTokens: 500 }),
  entry({ day: 6, backend: "codex", threadId: "c1", cwd: "/work/beta", model: "gpt-5.6-luna", provider: "openai", modelId: "gpt-5.6-luna", billing: "subscription", apiValueUsd: 2, totalTokens: 9_000, requests: 4 }),
  entry({ day: 6, threadId: "t2", cwd: "/work/beta", costUsd: 0.25, totalTokens: 250 }),
];

describe("usage dashboard", () => {
  it("starts each day at local midnight, today last", () => {
    const days = dayStarts(3, new Date(2026, 8, 27, 15, 30));
    expect(days).toEqual([new Date(2026, 8, 25).getTime(), new Date(2026, 8, 26).getTime(), new Date(2026, 8, 27).getTime()]);
  });

  it("counts a period from the month's first day, 30 days back, or from before the days read", () => {
    const now = new Date(2026, 9, 3, 12);
    const days = dayStarts(40, now);
    expect(days[periodFrom("month", days, now)]).toBe(new Date(2026, 9, 1).getTime());
    expect(periodFrom("30d", days, now)).toBe(10);
    expect(periodFrom("all", days, now)).toBe(-1);
  });

  it("draws a bar for every day, empty ones included", () => {
    const days = dayStarts(7, new Date(2026, 8, 27));
    const series = dailyFigures(entries, days, 4);
    expect(series.map((day) => day.totalTokens)).toEqual([0, 500, 9_250]);
    expect(series[0]!.start).toBe(days[4]);
  });

  it("ranks projects, models with their runtime, and threads", () => {
    expect(rankUsage(entries, 0, "project", "cost", 5).map((item) => [item.cwd, item.costUsd, item.apiValueUsd])).toEqual([["/work/beta", 0.75, 2], ["/work/alpha", 1, 0]]);
    expect(rankUsage(entries, 0, "model", "tokens", 1).map((item) => [item.backend, item.model])).toEqual([["codex", "gpt-5.6-luna"]]);
    expect(rankUsage(entries, 6, "thread", "cost", 5).map((item) => item.threadId)).toEqual(["c1", "t2"]);
  });

  it("keeps a day's plan tokens and turns apart from what was paid per token", () => {
    const days = dayStarts(7, new Date(2026, 8, 27));
    expect(dailyFigures(entries, days, 6)[0]).toMatchObject({ costUsd: 0.25, apiValueUsd: 2, totalTokens: 9_250, planTokens: 9_000, planRequests: 4, requests: 5 });
  });

  it("ranks providers by company, a runtime standing for its provider, with the threads each counts", () => {
    expect([providerOf({ provider: "openai-codex", backend: "pi" }), providerOf({ backend: "claude-code" }), providerOf({ provider: "mistral", backend: "pi" })]).toEqual(["openai", "anthropic", "mistral"]);
    const ranked = rankUsage([...entries, entry({ day: 6, backend: "claude-code", provider: undefined, threadId: "s1", costUsd: 3 })], 0, "provider", "cost", 5);
    expect(ranked.map((item) => [item.provider, item.threads, item.costUsd])).toEqual([["anthropic", 3, 4.75], ["openai", 1, 0]]);
  });

  it("ranks projects by a key it is handed, so a worktree's threads count with their project", () => {
    const ranked = rankUsage(entries, 0, "project", "cost", 5, () => "one project");
    expect(ranked.map((item) => [item.key, item.threads])).toEqual([["\u0000one project", 3]]);
  });
});
