import { describe, expect, it } from "vitest";
import { cursorNewThreadCatalog, effortOption, storedModels } from "./catalog.js";
import { transportFailure } from "./extensions.js";

describe("Cursor catalog", () => {
  it("keeps each model once, with the efforts of its reasoning option", () => {
    const models = storedModels([
      { value: "gpt-5.4", name: "GPT-5.4", configOptions: [
        { type: "select", id: "fast", name: "Fast", category: "model_config", currentValue: "false", options: [{ value: "false", name: "Off" }] },
        { type: "select", id: "reasoning", name: "Reasoning", category: "thought_level", currentValue: "medium", options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] },
      ] },
      { value: "gpt-5.4", name: "Duplicate" },
      { value: " ", name: "Blank" },
      { value: "composer-2", name: "" },
    ]);
    expect(models).toEqual([{ id: "gpt-5.4", name: "GPT-5.4", efforts: ["low", "high"] }, { id: "composer-2", name: "composer-2", efforts: [] }]);
    expect(cursorNewThreadCatalog(models)).toMatchObject({ model: { id: "gpt-5.4" }, thinkingLevels: { "gpt-5.4": ["default", "low", "high"], "composer-2": ["default"] } });
    expect(cursorNewThreadCatalog([])).toMatchObject({ models: [], status: "unavailable" });
  });

  it("prefers the model's own effort option over a thought level", () => {
    const option = effortOption([
      { type: "select", id: "thinking_level", name: "Reasoning", category: "thought_level", currentValue: "a", options: [] },
      { type: "select", id: "effort", name: "Effort", category: "model_option", currentValue: "b", options: [] },
    ]);
    expect(option?.id).toBe("effort");
  });

  it("tells a transport diagnostic from an answer that quotes one", () => {
    expect(transportFailure("Error: ConnectError: [unavailable] upstream\n    at x (y.js:1)")).toBe("Error: ConnectError: [unavailable] upstream");
    expect(transportFailure("Something went wrong communicating with the server. Please try again.")).toBeDefined();
    expect(transportFailure("The log said:\nError: ConnectError: [unavailable] upstream")).toBeUndefined();
    expect(transportFailure("Error: RetriableError: [internal] oops")).toBeUndefined();
  });
});
