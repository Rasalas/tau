import { describe, expect, it } from "vitest";
import { dayStarts, HISTORY_DAYS } from "./dashboard.js";
import { monthFigures, monthStart } from "./month.js";
import type { UsageEntry } from "./protocol.js";

const NOW = new Date(2026, 8, 10, 12, 0);
const days = dayStarts(HISTORY_DAYS, NOW);
const dayOf = (date: Date) => days.indexOf(new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime());

function entry(date: Date, overrides: Partial<UsageEntry> = {}): UsageEntry {
  return {
    day: dayOf(date), backend: "pi", threadId: `t-${date.getDate()}`, cwd: "/work", model: "m", requests: 2,
    inputTokens: 900, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 1_000, costUsd: 1, apiValueUsd: 0,
    ...overrides,
  };
}

describe("this month in the sidebar", () => {
  it("starts at local midnight on the first of the month", () => {
    expect(monthStart(new Date(2026, 8, 29, 17, 5))).toBe(new Date(2026, 8, 1).getTime());
  });

  it("sums the month so far, the month before up to the same day, and where the month is headed", () => {
    const entries = [
      entry(new Date(2026, 8, 1)), entry(new Date(2026, 8, 9), { costUsd: 3, apiValueUsd: 2 }),
      // August: the 5th counts, the 20th is after the same day.
      entry(new Date(2026, 7, 5), { costUsd: 2 }), entry(new Date(2026, 7, 20), { costUsd: 50 }),
    ];
    const month = monthFigures(entries, days, NOW);
    expect(month.current).toMatchObject({ costUsd: 4, apiValueUsd: 2, totalTokens: 2_000, requests: 4, threads: 2 });
    expect(month.previous?.figures.costUsd).toBe(2);
    expect(month.previous?.name).toBe(new Date(2026, 7, 1).toLocaleString(undefined, { month: "long" }));
    // 9.5 days gone of 30.
    expect(month.projected?.costUsd).toBeCloseTo(4 * 30 / 9.5, 5);
  });

  it("has no projection in its first two days and no comparison without the month before", () => {
    const early = new Date(2026, 8, 2, 9, 0);
    const month = monthFigures([entry(new Date(2026, 8, 1))].map((item) => ({ ...item, day: dayStarts(HISTORY_DAYS, early).indexOf(new Date(2026, 8, 1).getTime()) })), dayStarts(HISTORY_DAYS, early), early);
    expect(month.current.costUsd).toBe(1);
    expect(month.projected).toBeUndefined();
    expect(month.previous).toBeUndefined();
  });
});
