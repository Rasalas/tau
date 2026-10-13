import { describe, expect, it } from "vitest";
import { pageChord, pageModifier } from "./shortcut.js";

describe("the preview page's chords as hints", () => {
  it("draws ⌘ on macOS and spells Ctrl out elsewhere", () => {
    expect(["R", "0", "+", "−"].map((key) => pageChord(key, true))).toEqual(["⌘R", "⌘0", "⌘+", "⌘−"]);
    expect(["R", "0", "+", "−"].map((key) => pageChord(key, false))).toEqual(["Ctrl+R", "Ctrl+0", "Ctrl+Plus", "Ctrl+Minus"]);
    expect([pageModifier(true), pageModifier(false)]).toEqual(["⌘", "Ctrl"]);
  });
});
