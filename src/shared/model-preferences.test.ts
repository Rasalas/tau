import { describe, expect, it } from "vitest";
import { modelDisplayName, readModelPreferenceRecord, readModelPreferences } from "./model-preferences.js";

describe("model display names", () => {
  it("reads old arrangements and normalized labels without changing their keys", () => {
    expect(readModelPreferences({ hidden: ["a/b"], order: ["a/c"] })).toEqual({ hidden: ["a/b"], order: ["a/c"] });
    expect(readModelPreferences({ names: { "a/b": "  My model  " } })).toEqual({ names: { "a/b": "My model" } });
    expect(readModelPreferences({ names: {}, order: [] })).toEqual({});
    const model = { provider: "a", id: "b", name: "Catalog" };
    expect(modelDisplayName(model, { names: { "a/b": "Mine" } })).toBe("Mine");
    expect(modelDisplayName(model, { names: { "other/b": "Other" } })).toBe("Catalog");
    expect(model).toEqual({ provider: "a", id: "b", name: "Catalog" });
  });

  it.each([null, [], "name", { "": "Name" }, { ["k".repeat(301)]: "Name" }, { "a/b": " " }, { "a/b": 1 }, { "a/b": "x".repeat(121) }, { "a/b": "two\nlines" }, { "a/b": "bad\u0000" }])("refuses malformed names %j", (names) => {
    expect(readModelPreferences({ names })).toBeUndefined();
  });

  it("bounds the number of labels and drops invalid runtime entries", () => {
    const names = Object.fromEntries(Array.from({ length: 2001 }, (_, i) => [`p/${i}`, "Name"]));
    expect(readModelPreferences({ names })).toBeUndefined();
    delete names["p/2000"];
    expect(Object.keys(readModelPreferences({ names })!.names!)).toHaveLength(2000);
    expect(readModelPreferenceRecord({ pi: { names: { "a/b": "Pi" } }, bad: { names: [] } })).toEqual({ pi: { names: { "a/b": "Pi" } } });
  });
});
