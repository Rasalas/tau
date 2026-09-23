import { describe, expect, it } from "vitest";
import { costAt, priceOverride, readModelPrices, withPriceOverride } from "./model-prices";

describe("model prices", () => {
  it("keeps valid entries and drops the rest", () => {
    expect(readModelPrices({
      "openai/gpt-5.6-luna": { input: 0.2, output: 1.2 },
      "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
      "bad/negative": { input: -1, output: 1 },
      "bad/cache": { input: 1, output: 1, cacheRead: "x" },
      "": { input: 1, output: 1 },
    })).toEqual({
      "openai/gpt-5.6-luna": { input: 0.2, output: 1.2 },
      "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    });
    expect(readModelPrices([])).toBeUndefined();
  });

  it("finds a provider's price first, then the bare id, also without variant or date", () => {
    const prices = { "openai/gpt-5.6-luna": { input: 1, output: 2 }, "gpt-5.6-luna": { input: 3, output: 4 }, "claude-opus-5": { input: 5, output: 25 } };
    expect(priceOverride(prices, "openai", "gpt-5.6-luna")).toEqual({ input: 1, output: 2 });
    expect(priceOverride(prices, "openai-codex", "gpt-5.6-luna")).toEqual({ input: 3, output: 4 });
    expect(priceOverride(prices, "anthropic", "claude-opus-5-20260101[1m]")).toEqual({ input: 5, output: 25 });
    expect(priceOverride(prices, "anthropic", "claude-sonnet-5")).toBeUndefined();
    expect(priceOverride(undefined, "openai", "gpt-5.6-luna")).toBeUndefined();
  });

  it("puts the user's price on a model", () => {
    const model = { provider: "openai", id: "o4-mini", name: "o4-mini", price: { input: 1.1, output: 4.4 } };
    expect(withPriceOverride(model, { "o4-mini": { input: 1, output: 2 } })).toEqual({ model: { ...model, price: { input: 1, output: 2 } }, custom: true });
    expect(withPriceOverride(model, {})).toEqual({ model, custom: false });
  });

  it("prices cache tokens at the input rate when no cache rate is given", () => {
    const tokens = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 0 };
    expect(costAt(tokens, { input: 1, output: 2 })).toBe(4);
    expect(costAt(tokens, { input: 1, output: 2, cacheRead: 0.1 })).toBeCloseTo(3.1);
  });
});
