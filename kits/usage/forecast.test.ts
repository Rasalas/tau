import { describe, expect, it } from "vitest";
import { dayStarts } from "./dashboard.js";
import { providerForecasts } from "./forecast.js";
import type { UsageEntry } from "./protocol.js";

const now = new Date(2026, 9, 3, 16);
const days = dayStarts(90, now);
const entry = (ago: number, fields: Partial<UsageEntry> = {}): UsageEntry => ({
  day: days.length - 1 - ago, backend: "opencode", threadId: "t", cwd: "/work", provider: "openrouter", model: "m",
  inputTokens: 900, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 1_000,
  requests: 1, costUsd: 2, apiValueUsd: 0, ...fields,
});

describe("monthly provider forecasts", () => {
  it("counts idle calendar days, excludes today from the average, and uses this month's length", () => {
    const [row] = providerForecasts([entry(0, { costUsd: 100 }), entry(1, { costUsd: 7 }), entry(7, { costUsd: 7 }), entry(8, { costUsd: 70 })], days, now, 7);
    expect(row).toMatchObject({ provider: "openrouter", monthBilledUsd: 107, monthValueUsd: 107, dailyValueUsd: 2, monthlyValueUsd: 62, unknownTokens: 0 });
  });

  it("switches to 30 days and merges runtimes of the same provider", () => {
    const rows = providerForecasts([entry(1, { costUsd: 30 }), entry(15, { backend: "pi", costUsd: 60 }), entry(31, { costUsd: 500 })], days, now, 30);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ dailyValueUsd: 3, monthlyValueUsd: 93 });
  });

  it("keeps actual spend separate from the API equivalent of plans and free usage", () => {
    const [row] = providerForecasts([
      entry(1, { costUsd: 7 }),
      entry(1, { costUsd: 0, billing: "subscription", apiValueUsd: 14 }),
      entry(1, { costUsd: 0, billing: "free", apiEquivalentUsd: 21 }),
    ], days, now, 7);
    expect(row).toMatchObject({ monthBilledUsd: 7, monthValueUsd: 42, dailyValueUsd: 6, monthlyValueUsd: 186 });
  });

  it("marks missing prices while accepting a known zero price", () => {
    const [row] = providerForecasts([
      entry(1, { costUsd: 7 }), entry(1, { costUsd: 0 }),
      entry(1, { costUsd: 0, apiEquivalentUsd: 0 }),
      entry(0, { costUsd: 0, totalTokens: 2_000 }),
    ], days, now, 7);
    expect(row).toMatchObject({ unknownTokens: 1_000, monthUnknownTokens: 3_000, monthlyValueUsd: 31 });
  });

  it("uses February's 28 days and never includes undated or future entries", () => {
    const date = new Date(2026, 1, 10, 12);
    const starts = dayStarts(90, date);
    const [row] = providerForecasts([entry(1, { costUsd: 7 }), entry(0, { day: -1, costUsd: 100 }), entry(0, { day: 90, costUsd: 100 })], starts, date, 7);
    expect(row?.monthlyValueUsd).toBe(28);
  });
});
