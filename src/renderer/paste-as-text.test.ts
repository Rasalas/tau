import { describe, expect, it } from "vitest";
import { armPasteAsText, disarmPasteAsText, isPasteAsTextChord, takePasteAsText } from "./paste-as-text";

describe("paste as text", () => {
  it("applies to the one paste that follows within a second", () => {
    armPasteAsText(1_000);
    expect(takePasteAsText(1_500)).toBe(true);
    expect(takePasteAsText(1_600)).toBe(false);
    armPasteAsText(1_000);
    expect(takePasteAsText(2_001)).toBe(false);
    armPasteAsText(1_000);
    disarmPasteAsText();
    expect(takePasteAsText(1_001)).toBe(false);
  });

  it("knows the chord per platform", () => {
    const chord = { key: "V", shiftKey: true, altKey: false };
    expect(isPasteAsTextChord({ ...chord, metaKey: true, ctrlKey: false }, true)).toBe(true);
    expect(isPasteAsTextChord({ ...chord, metaKey: false, ctrlKey: true }, true)).toBe(false);
    expect(isPasteAsTextChord({ ...chord, metaKey: false, ctrlKey: true }, false)).toBe(true);
    expect(isPasteAsTextChord({ ...chord, shiftKey: false, metaKey: true, ctrlKey: false }, true)).toBe(false);
  });
});
