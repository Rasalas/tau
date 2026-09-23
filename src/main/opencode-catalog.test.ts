import { describe, expect, it } from "vitest";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { openCodeCatalogSubset, releaseDateKey, releaseDates, withOpenCodeCatalog } from "./opencode-catalog.js";

const catalog = {
  "opencode-go": {
    npm: "@ai-sdk/openai-compatible",
    models: {
      "new-model": {
        id: "new-model", name: "New model", tool_call: true, reasoning: true,
        provider: { npm: "@ai-sdk/anthropic" },
        modalities: { input: ["text", "image"], output: ["text"] },
        limit: { context: 262144, output: 131072 },
        cost: { input: 0, output: 0, cache_read: 0 },
      },
    },
  },
};

describe("OpenCode catalog", () => {
  it("makes newly published models available without a manual model entry", async () => {
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null, refreshOnCreate: false,
    });
    runtime.registerNativeProvider(withOpenCodeCatalog(opencodeGoProvider(), catalog));
    await runtime.setRuntimeApiKey("opencode-go", "test-key");
    await runtime.refresh({ providers: ["opencode-go"], allowNetwork: false });
    expect(await runtime.getAvailable("opencode-go")).toContainEqual(expect.objectContaining({
      id: "new-model", api: "anthropic-messages", baseUrl: "https://opencode.ai/zen/go",
      contextWindow: 262144, maxTokens: 131072, input: ["text", "image"],
    }));
    expect(runtime.getModel("opencode-go", "minimax-m3")).toBeDefined();
  });

  it("keeps only the providers Tau registers from the whole catalog", () => {
    const whole = { ...catalog, anthropic: { models: { big: {} } }, openai: { models: {} } };
    expect(openCodeCatalogSubset(whole, ["opencode-go", "opencode"])).toEqual(catalog);
    expect(openCodeCatalogSubset("not a catalog", ["opencode"])).toBe("not a catalog");
  });

  // The model picker and Usage show these prices; the trim must not take them.
  it("keeps each model's price through the trim", () => {
    const priced = { "opencode-go": { ...catalog["opencode-go"], models: { "new-model": { ...catalog["opencode-go"].models["new-model"], cost: { input: 0.6, output: 2.4, cache_read: 0.06 } } } } };
    const provider = withOpenCodeCatalog(opencodeGoProvider(), openCodeCatalogSubset({ ...priced, openai: { models: {} } }, ["opencode-go"]));
    expect(provider.getModels().find((model) => model.id === "new-model")?.cost).toEqual({ input: 0.6, output: 2.4, cacheRead: 0.06, cacheWrite: 0 });
  });

  // The picker's "Newest" sort reads these; only the dates outlive the parse.
  it("keeps each model's earliest release date from every provider, by its bare id", () => {
    const dates = releaseDates({
      openai: { models: { "gpt-5.6-luna": { release_date: "2026-05-02" }, "o4-mini": { release_date: "bogus" } } },
      openrouter: { models: { "openai/gpt-5.6-luna": { release_date: "2026-05-01" }, "anthropic/claude-haiku-4-5-20251001": { release_date: "2025-10-01" } } },
      broken: "not a provider",
    });
    expect(dates.get("gpt-5.6-luna")).toBe("2026-05-01");
    expect(dates.has("o4-mini")).toBe(false);
    expect(dates.get(releaseDateKey("claude-haiku-4-5[1m]"))).toBe("2025-10-01");
  });
});
