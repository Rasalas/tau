// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import type { PreferencesStore } from "tau";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import { migrateTextGeneration, textChoice, textChoiceInput, TEXT_GENERATION_OPTIONS, TEXT_GENERATION_OWNER as OWNER } from "./text-generation.js";

let preferences: PreferencesStore;
beforeEach(() => { preferences = createKitHarness().preferences; });

describe("Text generation: one default, an override per kind", () => {
  it("chooses nothing until a model or a runtime is named", () => {
    expect(textChoice(preferences, "title")).toBeUndefined();
    expect(textChoiceInput(undefined)).toEqual({});
  });

  it("gives every kind the default's model, effort and runtime, and a kind's own model its own effort", () => {
    preferences.setValue(OWNER, "text-model", "openai/gpt-mini");
    preferences.setValue(OWNER, "text-effort", "low");
    preferences.setValue(OWNER, "text-runtime", "pi");
    for (const kind of ["title", "commit", "pr"] as const) {
      expect(textChoice(preferences, kind)).toEqual({ model: { provider: "openai", id: "gpt-mini" }, effort: "low", runtime: "pi" });
    }
    preferences.setValue(OWNER, "commit-model", "anthropic/haiku");
    // The default's effort belongs to its model, never to another one.
    expect(textChoice(preferences, "commit")).toEqual({ model: { provider: "anthropic", id: "haiku" }, runtime: "pi" });
    preferences.setValue(OWNER, "commit-effort", "high");
    preferences.setValue(OWNER, "commit-runtime", "thread");
    expect(textChoice(preferences, "commit")).toEqual({ model: { provider: "anthropic", id: "haiku" }, effort: "high", runtime: "thread" });
    expect(textChoiceInput(textChoice(preferences, "commit"))).toEqual({ thinkingLevel: "high", runtime: "thread" });
    expect(textChoice(preferences, "pr")?.model).toEqual({ provider: "openai", id: "gpt-mini" });
  });

  it("keeps reading Thread Titles' old model until the titles' own is written, even as empty", () => {
    preferences.setValue("tau.thread-titles", "model", "openai/gpt-nano");
    expect(textChoice(preferences, "title")?.model).toEqual({ provider: "openai", id: "gpt-nano" });
    preferences.setValue(OWNER, "title-model", "");
    expect(textChoice(preferences, "title")).toBeUndefined();
  });

  it("moves the old choices in once: the old title model to the titles, the commit model to the descriptions", () => {
    preferences.setValue("tau.thread-titles", "model", "openai/gpt-nano");
    preferences.setValue(OWNER, "commit-model", "anthropic/haiku");
    preferences.setValue(OWNER, "commit-effort", "medium");
    migrateTextGeneration(preferences);
    expect(preferences.value(OWNER, "title-model")).toBe("openai/gpt-nano");
    expect(preferences.value(OWNER, "pr-model")).toBe("anthropic/haiku");
    expect(preferences.value(OWNER, "pr-effort")).toBe("medium");
    // A choice cleared afterwards stays cleared.
    preferences.setValue(OWNER, "pr-model", "");
    migrateTextGeneration(preferences);
    expect(preferences.value(OWNER, "pr-model")).toBe("");
  });

  it("lays the choices out as model rows, each with its effort, and a runtime beside each", () => {
    expect(TEXT_GENERATION_OPTIONS.map((option) => [option.id, option.kind])).toEqual([
      ["text-model", "model"], ["text-runtime", "select"],
      ["title-model", "model"], ["title-runtime", "select"],
      ["commit-model", "model"], ["commit-runtime", "select"],
      ["pr-model", "model"], ["pr-runtime", "select"],
    ]);
    expect(TEXT_GENERATION_OPTIONS.filter((option) => option.kind === "model").map((option) => option.kind === "model" && option.thinkingLevelValue)).toEqual(["text-effort", "title-effort", "commit-effort", "pr-effort"]);
  });
});

describe("Review Kit holds the one place the choices are made", () => {
  it("lists them on its page before the guides' model, and moves the old choices in when it starts", async () => {
    const { reviewExtension } = await import("../review/desktop.js");
    const harness = createKitHarness();
    harness.preferences.setValue("tau.thread-titles", "model", "openai/gpt-nano");
    harness.preferences.setValue(OWNER, "commit-model", "anthropic/haiku");
    harness.registry.activate(reviewExtension);
    const options = harness.registry.getExtensionSummaries().find((summary) => summary.id === OWNER)!.options.map((option) => option.id);
    expect(options.slice(0, 8)).toEqual(TEXT_GENERATION_OPTIONS.map((option) => option.id));
    expect(options).toContain("review-guide-model");
    expect(harness.preferences.value(OWNER, "title-model")).toBe("openai/gpt-nano");
    expect(harness.preferences.value(OWNER, "pr-model")).toBe("anthropic/haiku");
    harness.registry.deactivate(OWNER);
  });
});
