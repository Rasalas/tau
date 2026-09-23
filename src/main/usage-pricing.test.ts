import { describe, expect, it, vi } from "vitest";
import { UsagePricing, appendUsageTurn, legacyUsageTurn, mergeTallies, priceTally, readUsageTally, readUsageTurns, threadUsageFrom, unpricedUsage, type UsagePriceSource, type UsageTally, type UsageTurn } from "./usage-pricing.js";

const MTOK = 1_000_000;

function tally(fields: Partial<UsageTally>): UsageTally {
  return { inputTokens: MTOK, outputTokens: MTOK, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2 * MTOK, costUsd: 0, turns: 1, ...fields };
}

function source(overrides: UsagePriceSource["overrides"] = () => undefined): UsagePriceSource {
  return {
    overrides,
    apiPrice: (_provider, model) => model.startsWith("gpt-5.6-luna") ? { input: 0.2, output: 1.2 } : undefined,
    subscription: (provider) => provider === "openai-codex" || provider === "anthropic",
  };
}

describe("usage pricing", () => {
  it("values a subscription at the API price and bills nothing for it", () => {
    expect(priceTally(tally({ provider: "openai-codex", model: "gpt-5.6-luna" }), source()))
      .toEqual({ billing: "subscription", costUsd: 0, apiValueUsd: expect.closeTo(1.4) as number, source: "api" });
  });

  it("takes a runtime's own price for the subscription's value, and bills an API key", () => {
    expect(priceTally(tally({ provider: "anthropic", model: "claude-haiku-4-5", costUsd: 0.5 }), source()))
      .toEqual({ billing: "subscription", costUsd: 0, apiValueUsd: 0.5, source: "runtime" });
    expect(priceTally(tally({ provider: "openai", model: "gpt-5.6-luna", billing: "api-key" }), source()))
      .toMatchObject({ billing: "api-key", costUsd: expect.closeTo(1.4) as number, apiValueUsd: 0, source: "api" });
  });

  it("lets the user's price win over every other", () => {
    const priced = priceTally(tally({ provider: "openai", model: "gpt-5.6-luna", billing: "api-key", costUsd: 9 }), source(() => ({ "gpt-5.6-luna": { input: 1, output: 1 } })));
    expect(priced).toMatchObject({ costUsd: 2, source: "custom" });
  });

  it("leaves an unknown login at the runtime's price and never looks one up", () => {
    expect(priceTally(tally({ provider: "opencode-go", model: "gpt-5.6-luna" }), source())).toEqual({ costUsd: 0, apiValueUsd: 0, source: "none" });
  });

  it("sums a thread with the subscription's share apart", () => {
    const usage = threadUsageFrom([
      tally({ provider: "openai-codex", model: "gpt-5.6-luna", turns: 2 }),
      tally({ provider: "openai", model: "o4-mini", costUsd: 0.25 }),
    ], source());
    expect(usage).toMatchObject({ totalTokens: 4 * MTOK, turns: 3, costUsd: 0.25, subscription: { totalTokens: 2 * MTOK, turns: 2 } });
    expect(usage?.subscription?.apiValueUsd).toBeCloseTo(1.4);
    expect(threadUsageFrom([], source())).toBeUndefined();
    expect(threadUsageFrom([tally({ provider: "openai", model: "o4-mini", costUsd: 1 })], source())?.subscription).toBeUndefined();
  });

  it("merges tallies of one model and billing", () => {
    const merged = mergeTallies([tally({ model: "a" }), tally({ model: "a", costUsd: 1 }), tally({ model: "a", billing: "subscription" })]);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ model: "a", turns: 2, costUsd: 1 });
  });

  it("reads a tally from outside and rejects a malformed one", () => {
    expect(readUsageTally({ ...tally({ model: "m", billing: "subscription" }), extra: 1 })).toEqual(tally({ model: "m", billing: "subscription" }));
    expect(readUsageTally({ ...tally({}), turns: -1 })).toBeUndefined();
    expect(readUsageTally({ ...tally({}), billing: "barter" })).toEqual(tally({}));
  });

  it("announces Pi's data once it is loaded and a change of the user's prices", async () => {
    let prices: Record<string, { input: number; output: number }> = {};
    const onChange = vi.fn();
    const pricing = new UsagePricing({
      load: async () => ({ apiPrice: () => ({ input: 1, output: 1 }), subscription: (provider) => provider === "anthropic" }),
      readPrices: () => prices,
      onChange,
    });
    expect(pricing.subscription("anthropic")).toBe(false);
    await pricing.ready();
    expect(pricing.subscription("anthropic")).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(1);
    pricing.reloadPrices();
    expect(onChange).toHaveBeenCalledTimes(1);
    prices = { m: { input: 2, output: 2 } };
    pricing.reloadPrices();
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(pricing.price(tally({ model: "m" }))).toMatchObject({ costUsd: 4, source: "custom" });
  });
});

describe("usage turns", () => {
  it("folds the oldest turns once a thread keeps too many", () => {
    let turns: UsageTurn[] = [];
    for (let at = 1; at <= 5; at += 1) turns = appendUsageTurn(turns, { ...tally({ model: "m" }), at }, 3);
    expect(turns.map((turn) => [turn.at, turn.turns])).toEqual([[3, 3], [4, 1], [5, 1]]);
    expect(turns[0]?.model).toBe("m");
  });

  it("reads stored turns and keeps an old running total as one", () => {
    expect(readUsageTurns([{ ...tally({}), at: 5 }, { ...tally({}) }, "x"])).toEqual([{ ...tally({}), at: 5 }]);
    expect(readUsageTurns(undefined)).toBeUndefined();
    expect(legacyUsageTurn({ ...tally({}), turns: 4 }, 9, { model: "gpt-5.6-luna" })).toMatchObject({ at: 9, model: "gpt-5.6-luna", turns: 4 });
    expect(unpricedUsage([tally({ costUsd: 1 }), tally({ costUsd: 2 })])).toMatchObject({ costUsd: 3, turns: 2 });
  });
});
