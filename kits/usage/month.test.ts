import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostExtensionClient } from "tau";
import { createMonthUsage, MONTH_AFTER_RUN_MS, MONTH_FIRST_READ_MS, monthStart, monthSummary } from "./month.js";
import { USAGE_SUMMARY_COMMAND, type UsageSummary, type UsageTotals } from "./protocol.js";

function totals(overrides: Partial<UsageTotals> = {}): UsageTotals {
  return {
    requests: 40, inputTokens: 3_000_000, outputTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 3_100_000, costUsd: 12.4, threads: 22,
    subscription: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, requests: 0, apiValueUsd: 0 },
    ...overrides,
  };
}

describe("the month at the sidebar's foot", () => {
  it("reads as the design's figure: billed money, threads, tokens; the short form keeps the money", () => {
    expect(monthSummary(totals(), true)).toEqual({
      text: "$12.40 · 22 · 3.1M tok",
      short: "$12.40",
      hint: "This month · $12.40 billed per token · 22 threads · 3.1M tokens",
    });
  });

  it("never adds a plan's value to what was billed, and drops money when costs are hidden", () => {
    const plan = totals({ costUsd: 0, subscription: { ...totals().subscription, totalTokens: 3_100_000, apiValueUsd: 9.3 } });
    expect(monthSummary(plan, true)).toMatchObject({ text: "22 · 3.1M tok", short: "3.1M tok", hint: "This month · plans worth ≈ $9.30 at API prices · 22 threads · 3.1M tokens" });
    expect(monthSummary(totals(), false)).toMatchObject({ text: "22 · 3.1M tok", short: "3.1M tok" });
    expect(monthSummary(totals({ threads: 1 }), false)?.hint).toContain("1 thread ·");
    expect(monthSummary(totals({ threads: 0, totalTokens: 0, costUsd: 0 }), true)).toBeUndefined();
  });

  it("starts at local midnight on the first of the month", () => {
    expect(monthStart(new Date(2026, 8, 29, 17, 5))).toBe(new Date(2026, 8, 1).getTime());
  });
});

describe("the month's reads", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const summary = (costUsd: number): UsageSummary => ({ scannedAt: 1, totals: totals({ costUsd }), rows: [], sources: [] });

  it("reads once the window has settled, from the first of the month, and again after a run ends", async () => {
    const invoke = vi.fn(async () => summary(invoke.mock.calls.length === 1 ? 1 : 2));
    const month = createMonthUsage({ invoke } as unknown as HostExtensionClient, () => new Date(2026, 8, 29, 12));
    month.runEnded();
    const listener = vi.fn();
    const stop = month.subscribe(listener);
    expect(invoke).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(MONTH_FIRST_READ_MS);
    expect(invoke).toHaveBeenCalledWith(USAGE_SUMMARY_COMMAND, { since: new Date(2026, 8, 1).getTime() });
    expect(month.getSnapshot().totals?.costUsd).toBe(1);
    expect(listener).toHaveBeenCalledOnce();

    month.runEnded();
    month.runEnded();
    await vi.advanceTimersByTimeAsync(MONTH_AFTER_RUN_MS);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(month.getSnapshot().totals?.costUsd).toBe(2);

    // Nobody draws it: nothing is read.
    stop();
    month.runEnded();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("keeps the icon when the host cannot answer", async () => {
    const month = createMonthUsage({ invoke: vi.fn(async () => { throw new Error("no host"); }) } as unknown as HostExtensionClient);
    const stop = month.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(MONTH_FIRST_READ_MS);
    expect(month.getSnapshot().totals).toBeUndefined();
    stop();
  });
});
