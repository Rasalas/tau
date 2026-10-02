import { describe, expect, it } from "vitest";
import { insertDictation } from "./dictation";
describe("reviewed dictation insertion", () => {
  it("inserts at the cursor captured before recording", () => { expect(insertDictation("Hello world", 6, 6, "local ")).toEqual({ text: "Hello local world", caret: 12 }); });
  it("replaces the original selection and clamps stale bounds", () => {
    expect(insertDictation("a OLD b", 2, 5, "new")).toEqual({ text: "a new b", caret: 5 });
    expect(insertDictation("a", 20, 30, "b")).toEqual({ text: "ab", caret: 2 });
  });
});
