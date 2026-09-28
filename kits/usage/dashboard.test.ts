import { describe, expect, it } from "vitest";
import { dailyFigures, dayStarts, figuresFrom, niceCeiling, rankUsage } from "./dashboard.js";
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

  it("answers today, the week and the month from one read, money and plan value apart", () => {
    expect(figuresFrom(entries, 6)).toEqual({ costUsd: 0.25, apiValueUsd: 2, totalTokens: 9_250, requests: 5, threads: 2 });
    expect(figuresFrom(entries, 0)).toMatchObject({ costUsd: 1.75, apiValueUsd: 2, threads: 3 });
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

  it("rounds an axis up to 1, 2 or 5 of a power of ten", () => {
    expect([0, 0.3, 1.2, 4, 7, 12_345].map(niceCeiling)).toEqual([1, 0.5, 2, 5, 10, 20_000]);
  });

  it("splits each day and each ranked row by provider colour, in one order", () => {
    const days = dayStarts(7, new Date(2026, 8, 27));
    const series = dailyFigures([...entries, entry({ day: 6, backend: "pi", provider: "google", totalTokens: 5 })], days, 4);
    expect(series[2]!.parts.map((part) => [part.tone, part.totalTokens])).toEqual([["openai", 9_000], ["anthropic", 250], ["google", 5]]);
    expect(rankUsage(entries, 0, "project", "cost", 5)[0]!.parts.map((part) => part.tone)).toEqual(["openai", "anthropic"]);
  });
});
