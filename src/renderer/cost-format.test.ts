import { describe, expect, it } from "vitest";
import { formatCost, formatTokens, threadCostLabel, threadUsageDetail } from "./cost-format";

const usage = {
  inputTokens: 12_300,
  outputTokens: 2_100,
  cacheReadTokens: 8_000,
  cacheWriteTokens: 0,
  totalTokens: 22_400,
  costUsd: 0.4231,
  turns: 3,
};

describe("cost formatting", () => {
  it("shows money with two decimals and tiny amounts as a bound", () => {
    expect(formatCost(0.4231)).toBe("$0.42");
    expect(formatCost(12)).toBe("$12.00");
    expect(formatCost(0.004)).toBe("<$0.01");
    expect(formatCost(0.0000001)).toBe("<$0.01");
  });

  it("never shows a zero price; a model without pricing reports its tokens", () => {
    expect(formatCost(0)).toBeUndefined();
    expect(threadCostLabel({ ...usage, costUsd: 0 })).toBe("22.4k tok");
    expect(threadCostLabel({ ...usage, costUsd: 0, totalTokens: 0, turns: 0 })).toBeUndefined();
    expect(threadCostLabel(undefined)).toBeUndefined();
  });

  it("abbreviates token counts", () => {
    expect(formatTokens(842)).toBe("842");
    expect(formatTokens(12_300)).toBe("12.3k");
    expect(formatTokens(1_400_000)).toBe("1.4M");
  });

  it("expands into the split the money came from", () => {
    expect(threadUsageDetail(usage)).toBe("12.3k in · 2.1k out · 8.0k cache read · 3 turns");
    expect(threadUsageDetail({ ...usage, cacheReadTokens: 0, turns: 1 })).toBe("12.3k in · 2.1k out · 1 turn");
  });
});
