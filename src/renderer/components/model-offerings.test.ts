import { describe, expect, it } from "vitest";
import type { UiModel } from "../../shared/contracts";
import {
  contextChoices, formatPrice, formatTokens, modelFamily, offeringKey, orderedPositions, passesFilters, searchOfferings, searchScore, sortOfferings,
  type Offering,
} from "./model-offerings";
import { carriedLevel } from "../thinking-levels";
import { entryFacts, modelEntries, modelMaker } from "./model-entries";

let position = 0;
function offering(runtime: string, model: UiModel, extra: Partial<Offering> = {}): Offering {
  return {
    key: offeringKey(runtime, model), runtime, runtimeLabel: runtime === "pi" ? "Pi" : runtime[0]!.toUpperCase() + runtime.slice(1),
    model, levels: [], favourite: false, hidden: false, legacy: false, isNew: false, position: position++, ...extra,
  };
}

const lunaPi = offering("pi", { provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6 Luna", billing: "subscription", price: { input: 0.2, output: 1.2 }, contextWindow: 272_000, releasedAt: "2026-05-01" });
const lunaCodex = offering("codex", { provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6 Luna", billing: "subscription", price: { input: 0.2, output: 1.2 }, contextWindow: 400_000 });
const sol = offering("pi", { provider: "openai", id: "gpt-5.6-sol", name: "GPT-5.6 Sol", billing: "subscription", price: { input: 2, output: 12 }, releasedAt: "2026-06-01" });
const mini = offering("pi", { provider: "openai", id: "o4-mini", name: "o4-mini", billing: "api-key", price: { input: 1.1, output: 4.4 }, contextWindow: 200_000, images: true });
const flash = offering("pi", { provider: "opencode-go", id: "deepseek-flash", name: "DeepSeek Flash", billing: "api-key", price: { input: 0.1, output: 0.3 }, reasoning: true });
const local = offering("pi", { provider: "ollama", id: "qwen3:8b", name: "Qwen3 8B", billing: "local" });
const unpriced = offering("pi", { provider: "acme", id: "mystery", name: "Mystery", billing: "api-key" });
const all = [lunaPi, lunaCodex, sol, mini, flash, local, unpriced];

describe("offerings", () => {
  it("keys Pi's models as before and every other runtime's with its kind", () => {
    expect(lunaPi.key).toBe("openai/gpt-5.6-luna");
    expect(lunaCodex.key).toBe("codex:openai/gpt-5.6-luna");
    expect(modelFamily({ id: "openrouter/anthropic/claude-haiku-4-5-20251001" })).toBe(modelFamily({ id: "claude-haiku-4-5[1m]" }));
  });

  it("puts every plan before every API offering by price, and orders both by their API price", () => {
    expect(sortOfferings(all, "price").map((entry) => entry.key)).toEqual([
      // Plans, by what the same model costs over the API; Luna twice, by name then runtime.
      "codex:openai/gpt-5.6-luna", "openai/gpt-5.6-luna", "openai/gpt-5.6-sol",
      // The rest: local and free count as nothing, an unknown price goes last.
      "ollama/qwen3:8b", "opencode-go/deepseek-flash", "openai/o4-mini", "acme/mystery",
    ]);
  });

  it("sorts by context and by release date, the unknown last", () => {
    expect(sortOfferings(all, "context").slice(0, 3).map((entry) => entry.key)).toEqual(["codex:openai/gpt-5.6-luna", "openai/gpt-5.6-luna", "openai/o4-mini"]);
    expect(sortOfferings(all, "newest").slice(0, 2).map((entry) => entry.key)).toEqual(["openai/gpt-5.6-sol", "openai/gpt-5.6-luna"]);
  });

  it("finds a model by any word of its name, id, provider or runtime, and nothing that lacks one", () => {
    expect(searchScore(lunaPi, "luna")).toBeDefined();
    expect(searchScore(lunaPi, "5.6-luna")).toBeDefined();
    expect(searchScore(lunaCodex, "luna codex")).toBeDefined();
    expect(searchScore(lunaPi, "luna codex")).toBeUndefined();
    expect(searchScore(flash, "opencode")).toBeDefined();
    // Letters in order count only close together.
    expect(searchScore(lunaPi, "gpt56")).toBeDefined();
    expect(searchScore(offering("pi", { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5 (latest)" }), "luna")).toBeUndefined();
    // A name beats an id, a whole word a part of one.
    expect(searchScore(mini, "o4-mini")!).toBeLessThan(searchScore(flash, "flash")! + 1);
    expect(searchScore(sol, "sol")!).toBeLessThan(searchScore(lunaPi, "lun")! + 10);
  });

  it("groups search results by model, one row per offering, best group first", () => {
    const groups = searchOfferings(all, "luna", "relevance");
    expect(groups).toHaveLength(1);
    expect(groups[0]!.map((entry) => entry.runtime).sort()).toEqual(["codex", "pi"]);
    const byPrice = searchOfferings(all, "gpt", "price");
    expect(byPrice.map((group) => group[0]!.model.id)).toEqual(["gpt-5.6-luna", "gpt-5.6-sol"]);
  });

  it("filters by billing and by what a model can do", () => {
    const plans = { billing: new Set(["subscription"] as const), capabilities: new Set<never>() };
    expect(all.filter((entry) => passesFilters(entry, plans))).toHaveLength(3);
    expect(all.filter((entry) => passesFilters(entry, { billing: new Set(["free"] as const), capabilities: new Set() })).map((entry) => entry.key)).toEqual(["ollama/qwen3:8b"]);
    expect(all.filter((entry) => passesFilters(entry, { billing: new Set(), capabilities: new Set(["images"] as const) })).map((entry) => entry.key)).toEqual(["openai/o4-mini"]);
    expect(passesFilters(flash, { billing: new Set(), capabilities: new Set(["reasoning"] as const) })).toBe(true);
  });

  it("lists a runtime's models in the user's order first, then its own", () => {
    const models = [{ provider: "a", id: "1" }, { provider: "a", id: "2" }, { provider: "a", id: "3" }];
    expect([...orderedPositions(models, ["a/3", "gone/9", "a/1"])]).toEqual([["a/3", 0], ["a/1", 1], ["a/2", 2]]);
  });

  it("writes prices and context the way the columns show them", () => {
    expect(formatPrice({ input: 0.2, output: 1.2 })).toBe("$0.2/$1.2");
    expect(formatPrice({ input: 3, output: 15 })).toBe("$3/$15");
    expect(formatTokens(400_000)).toBe("400k");
    expect(formatTokens(1_050_000)).toBe("1.05M");
  });
});

describe("models across runtimes (K142)", () => {
  it("names a model's maker by its id, and keeps the provider for a set only a runtime or gateway names", () => {
    expect(modelMaker({ provider: "openai-codex", id: "gpt-6-sol" })).toBe("openai");
    expect(modelMaker({ provider: "openrouter", id: "anthropic/claude-sonnet-4.5" })).toBe("anthropic");
    expect(modelMaker({ provider: "opencode-go", id: "kimi-k3" })).toBe("moonshot");
    expect(modelMaker({ provider: "opencode", id: "big-pickle" })).toBe("opencode");
  });

  it("lists a model once with one way per runtime and provider, a dated or [1m] twin behind its plain id", () => {
    const plain = offering("claude-code", { provider: "anthropic", id: "claude-opus-5-5", name: "Claude Opus 5.5", contextWindow: 200_000 });
    const wide = offering("claude-code", { provider: "anthropic", id: "claude-opus-5-5[1m]", name: "Claude Opus 5.5 (1M)", contextWindow: 1_000_000 });
    const pi = offering("pi", { provider: "anthropic", id: "claude-opus-5-5", name: "Claude Opus 5.5 (latest)", billing: "subscription", contextWindow: 1_000_000 });
    const [entry] = modelEntries([wide, plain, pi]);
    expect(entry!.name).toBe("Claude Opus 5.5");
    expect(entry!.ways.map((way) => way.key)).toEqual([plain.key, pi.key]);
    // The model in use stands for its way.
    expect(modelEntries([wide, plain, pi], wide.key)[0]!.ways[0]!.key).toBe(wide.key);
    expect(entryFacts(entry!.ways)).toBe("200k–1M");
    expect(entryFacts([lunaPi, lunaCodex])).toBe("272k–400k · API $0.2/$1.2");
  });

  it("offers a context window only where the same model has more than one", () => {
    const base = { provider: "anthropic", id: "claude-opus-5-5", name: "Opus" };
    const wide = { provider: "anthropic", id: "claude-opus-5-5[1m]", name: "Opus 1M" };
    expect(contextChoices([base, wide], base).map((choice) => [choice.model.id, choice.tokens])).toEqual([["claude-opus-5-5", 0], ["claude-opus-5-5[1m]", 1_000_000]]);
    expect(contextChoices([base], base)).toEqual([]);
  });

  it("carries a thinking level over, or the next lower one the new model has", () => {
    expect(carriedLevel("xhigh", ["low", "medium", "high"])).toBe("high");
    expect(carriedLevel("high", ["off", "high", "max"])).toBe("high");
    expect(carriedLevel("low", ["high", "max"])).toBe("high");
    expect(carriedLevel("max", [])).toBe("max");
  });
});
