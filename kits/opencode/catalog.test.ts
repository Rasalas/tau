import { describe, expect, it } from "vitest";
import { openCodeBilling, openCodeNewThreadCatalog, parseModelRef, storedModels } from "./catalog.js";
import type { OpenCodeProviderList } from "./client.js";
import { FAKE_PROVIDERS } from "./fixtures/fake-server.js";

const providers = FAKE_PROVIDERS as unknown as OpenCodeProviderList;

describe("OpenCode's models in Tau's catalog", () => {
  it("lists the connected providers' current models, priced and with their levels", () => {
    const catalog = openCodeNewThreadCatalog(providers);
    expect(catalog.models.map((model) => `${model.provider}/${model.id}`)).toEqual(["opencode/big-pickle", "opencode/gpt-5.6-luna", "github-copilot/gpt-5.5"]);
    expect(catalog.models[1]).toEqual({
      provider: "opencode", id: "gpt-5.6-luna", name: "GPT-5.6 Luna", billing: "api-key",
      price: { input: 0.2, output: 1.2, cacheRead: 0.02 }, contextWindow: 400000, maxOutput: 128000, images: true, reasoning: true,
    });
    expect(catalog.models[0]).toMatchObject({ billing: "free" });
    expect(catalog.models[0]!.price).toBeUndefined();
    // A monthly plan carries no price of its own; the host fills the API price it would have had.
    expect(catalog.models[2]).toMatchObject({ billing: "subscription" });
    expect(catalog.models[2]!.price).toBeUndefined();
    expect(catalog.thinkingLevels).toMatchObject({ "gpt-5.6-luna": ["default", "low", "medium", "high"], "big-pickle": ["default"] });
    expect(catalog.model).toMatchObject({ provider: "opencode", id: "big-pickle" });
  });

  it("starts on the model OpenCode's config names", () => {
    expect(openCodeNewThreadCatalog(providers, { provider: "github-copilot", id: "gpt-5.5" }).model).toMatchObject({ provider: "github-copilot", id: "gpt-5.5" });
  });

  it("asks for a login when no provider is connected", () => {
    expect(openCodeNewThreadCatalog({ ...providers, connected: [] })).toMatchObject({ models: [], status: "sign-in-required" });
  });

  it("tells a plan, a key, a free offer and a local program apart", () => {
    expect(openCodeBilling("opencode-go", { id: "x", cost: { input: 1, output: 1 } })).toBe("subscription");
    expect(openCodeBilling("zai-coding-plan", { id: "x" })).toBe("subscription");
    expect(openCodeBilling("openrouter", { id: "x", cost: { input: 1, output: 2 } })).toBe("api-key");
    expect(openCodeBilling("opencode", { id: "x", cost: { input: 0, output: 0 } })).toBe("free");
    expect(openCodeBilling("openai", { id: "x", cost: { input: 0, output: 0 } })).toBe("subscription");
    expect(openCodeBilling("lmstudio", { id: "x" })).toBe("local");
  });

  it("keeps what a thread's picker needs before a server answers", () => {
    expect(storedModels(providers)).toContainEqual({ provider: "opencode", id: "gpt-5.6-luna", name: "GPT-5.6 Luna", variants: ["low", "medium", "high"], contextWindow: 400000 });
    expect(parseModelRef("openrouter/x-ai/grok")).toEqual({ provider: "openrouter", id: "x-ai/grok" });
    expect(parseModelRef("nothing")).toBeUndefined();
  });
});
