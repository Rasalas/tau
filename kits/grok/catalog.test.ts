import { describe, expect, it } from "vitest";
import { currentEffort, grokNewThreadCatalog, initializeModelState, modelName, storedModels } from "./catalog.js";

const INITIALIZED = {
  _meta: {
    modelState: {
      currentModelId: "grok-4.6",
      availableModels: [
        { modelId: "grok-4.6", name: "Grok 4.6", _meta: { totalContextTokens: 500_000, supportsReasoningEffort: true, reasoningEffort: "high", reasoningEfforts: [{ id: "xhigh", value: "xhigh" }, { id: "high", value: "high", default: true }, { value: "bad value!" }, { id: "high" }] } },
        { modelId: "grok-4.6-fast", name: "Grok 4.6 Fast", _meta: { supportsReasoningEffort: false, reasoningEfforts: [{ value: "low" }] } },
        { name: "no id" },
      ],
    },
  },
};

describe("Grok catalog", () => {
  it("reads the models initialize names, with efforts and context", () => {
    const state = initializeModelState(INITIALIZED);
    expect(currentEffort(state)).toBe("high");
    expect(storedModels(state)).toEqual([
      { id: "grok-4.6", name: "Grok 4.6", efforts: ["xhigh", "high"], contextWindow: 500_000 },
      { id: "grok-4.6-fast", name: "Grok 4.6 Fast", efforts: [] },
    ]);
    expect(initializeModelState({})).toBeUndefined();
    expect(modelName("grok-4.6-fast")).toBe("Grok 4.6 fast");
  });

  it("offers the models under xAI, billed as the login pays, starting on the CLI's current one", () => {
    const models = storedModels(initializeModelState(INITIALIZED));
    const catalog = grokNewThreadCatalog(models, { billing: "subscription", start: "grok-4.6-fast" });
    expect(catalog.model).toMatchObject({ provider: "xai", id: "grok-4.6-fast" });
    expect(catalog.models).toEqual([
      { provider: "xai", id: "grok-4.6", name: "Grok 4.6", billing: "subscription", contextWindow: 500_000, reasoning: true },
      { provider: "xai", id: "grok-4.6-fast", name: "Grok 4.6 Fast", billing: "subscription" },
    ]);
    expect(catalog.thinkingLevels).toEqual({ "grok-4.6": ["default", "xhigh", "high"], "grok-4.6-fast": ["default"] });
    expect(grokNewThreadCatalog(models, { billing: "api-key" }).models[0]?.billing).toBe("api-key");
    expect(grokNewThreadCatalog([], { billing: "subscription" })).toMatchObject({ models: [], status: "unavailable" });
  });
});
