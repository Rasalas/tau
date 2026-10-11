import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryStorage, setClientStorage } from "../../src/renderer/test-support/kit-harness.js";
import type { ClientStorage } from "tau";
import { createUsageView, toggleRuntime } from "./filters.js";

let storage: ClientStorage;
beforeEach(() => { storage = createMemoryStorage(); setClientStorage(storage); });
afterEach(() => setClientStorage(undefined));

describe("the Usage page's filters", () => {
  it("switches a runtime off and on, one at a time", () => {
    expect(toggleRuntime(undefined, "codex")).toEqual(["codex"]);
    expect(toggleRuntime(["codex", "pi"], "codex")).toEqual(["pi"]);
    expect(toggleRuntime(["pi"], "codex")).toEqual(["pi", "codex"]);
  });

  it("keeps the runtimes switched off on this device, so a reload and a new runtime find them as left", () => {
    const view = createUsageView();
    expect(view.getFilters().hiddenRuntimes).toBeUndefined();
    view.setFilters({ hiddenRuntimes: ["codex", "pi"] });
    // A new window of the same device reads them; the period and the measure start over.
    const reloaded = createUsageView();
    expect(reloaded.getFilters()).toEqual({ range: "month", metric: "cost", hiddenRuntimes: ["codex", "pi"] });
    reloaded.setFilters({ hiddenRuntimes: [] });
    expect(reloaded.getFilters().hiddenRuntimes).toBeUndefined();
    expect(createUsageView().getFilters().hiddenRuntimes).toBeUndefined();
  });

  it("starts with every runtime shown when the stored choice is damaged", () => {
    storage.set("device:tau.usage.hidden-runtimes", "{not json");
    expect(createUsageView().getFilters().hiddenRuntimes).toBeUndefined();
    storage.set("device:tau.usage.hidden-runtimes", JSON.stringify(["codex", 3]));
    expect(createUsageView().getFilters().hiddenRuntimes).toEqual(["codex"]);
  });
});
