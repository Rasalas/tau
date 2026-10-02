import { describe, expect, it } from "vitest";
import { dictationLanguage, insertDictation } from "./dictation";
describe("direct dictation insertion", () => {
  it("inserts at the cursor captured before recording", () => { expect(insertDictation("Hello world", 6, 6, "local ")).toEqual({ text: "Hello local world", caret: 12 }); });
  it("chooses the device language independently of list order and normalizes locale identifiers", () => {
    const languages = [{ id: "yue-CN" }, { id: "de_DE" }, { id: "en-US" }];
    expect(dictationLanguage(languages, "", "de-DE")).toBe("de_DE");
    expect(dictationLanguage(languages, "en-US", "de-DE")).toBe("en-US");
    expect(dictationLanguage(languages, "", "fr-FR")).toBeUndefined();
  });
  it("replaces the original selection and clamps stale bounds", () => {
    expect(insertDictation("a OLD b", 2, 5, "new")).toEqual({ text: "a new b", caret: 5 });
    expect(insertDictation("a", 20, 30, "b")).toEqual({ text: "ab", caret: 2 });
  });
});
