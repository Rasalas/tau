import { describe, expect, it } from "vitest";
import { PromptHistory, loadStoredPromptHistory, saveStoredPromptHistory } from "./prompt-history";
import { createMemoryStorage } from "./client-storage";

describe("PromptHistory", () => {
  it("records prompts and deduplicates consecutive entries", () => {
    const history = new PromptHistory();
    history.record("hello");
    history.record("hello");
    history.record("world");
    expect(history.getEntries()).toEqual(["hello", "world"]);
  });

  it("respects maxEntries capacity", () => {
    const history = new PromptHistory({ maxEntries: 2 });
    history.record("first");
    history.record("second");
    history.record("third");
    expect(history.getEntries()).toEqual(["second", "third"]);
  });

  it("navigates back and forward, restoring current draft", () => {
    const history = new PromptHistory({ initialEntries: ["alpha", "beta", "gamma"] });
    expect(history.isNavigating).toBe(false);

    // Navigate back from in-progress draft "my-draft"
    expect(history.navigateBack("my-draft")).toBe("gamma");
    expect(history.isNavigating).toBe(true);

    expect(history.navigateBack("ignored")).toBe("beta");
    expect(history.navigateBack("ignored")).toBe("alpha");
    // Remains at oldest
    expect(history.navigateBack("ignored")).toBe("alpha");

    // Navigate forward
    expect(history.navigateForward()).toBe("beta");
    expect(history.navigateForward()).toBe("gamma");
    // Moving forward past newest restores the saved draft
    expect(history.navigateForward()).toBe("my-draft");
    expect(history.isNavigating).toBe(false);
  });

  it("returns undefined when navigating forward without active navigation", () => {
    const history = new PromptHistory({ initialEntries: ["test"] });
    expect(history.navigateForward()).toBeUndefined();
  });

  it("resets cursor when recording new entry", () => {
    const history = new PromptHistory({ initialEntries: ["one"] });
    history.navigateBack("draft");
    expect(history.isNavigating).toBe(true);
    history.record("two");
    expect(history.isNavigating).toBe(false);
  });

  it("loads and saves persistent prompt history to ClientStorage", () => {
    const storage = createMemoryStorage();
    expect(loadStoredPromptHistory(storage)).toEqual([]);

    saveStoredPromptHistory(storage, ["first", "second"]);
    expect(loadStoredPromptHistory(storage)).toEqual(["first", "second"]);

    // Truncates to maxEntries
    saveStoredPromptHistory(storage, ["a", "b", "c"], 2);
    expect(loadStoredPromptHistory(storage, 2)).toEqual(["b", "c"]);

    // Handles corrupt JSON gracefully
    storage.set("tau.prompt-history", "not valid json");
    expect(loadStoredPromptHistory(storage)).toEqual([]);
  });
});
