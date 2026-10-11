import { describe, expect, it } from "vitest";
import { terminalMenuChoice, terminalMenuSections } from "./context-menu.js";

describe("terminalMenuSections", () => {
  it("offers Copy only with a selection and Paste only to a shell that takes input", () => {
    const [clipboard] = terminalMenuSections({ hasSelection: false, canType: false, mac: false });
    expect(clipboard!.items.map((item) => [item.id, item.disabled])).toEqual([["copy", true], ["paste", true]]);
    const [ready] = terminalMenuSections({ hasSelection: true, canType: true, mac: false });
    expect(ready!.items.map((item) => item.disabled)).toEqual([false, false]);
  });

  it("names the chords the view answers on each platform", () => {
    const hints = (mac: boolean) => terminalMenuSections({ hasSelection: false, canType: true, mac })[1]!.items.map((item) => item.hint);
    expect(hints(true)).toEqual(["⌘A", "⌘End"]);
    expect(hints(false)).toEqual(["Ctrl+Shift+A", "Ctrl+Shift+End"]);
  });

  it("answers only the menu's own ids", () => {
    expect(terminalMenuChoice("select-all")).toBe("select-all");
    expect(terminalMenuChoice("rm")).toBeUndefined();
    expect(terminalMenuChoice(undefined)).toBeUndefined();
  });
});
