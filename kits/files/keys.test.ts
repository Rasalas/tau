import { describe, expect, it } from "vitest";
import { editorKeyOutcome, indentUnit, type KeyLike } from "./keys.js";

const key = (value: string, modifiers: Partial<KeyLike> = {}): KeyLike => ({ key: value, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...modifiers });

describe("editorKeyOutcome", () => {
  it("leaves mod+s and the workbench's chords to the window", () => {
    expect(editorKeyOutcome(key("s", { metaKey: true }), true)).toBe("pass");
    expect(editorKeyOutcome(key("s", { ctrlKey: true }), false)).toBe("pass");
    expect(editorKeyOutcome(key("S", { metaKey: true, shiftKey: true }), true)).toBe("pass");
    expect(editorKeyOutcome(key("k", { metaKey: true }), true)).toBe("pass");
    expect(editorKeyOutcome(key("w", { ctrlKey: true }), false)).toBe("pass");
    expect(editorKeyOutcome(key("Tab", { ctrlKey: true }), true)).toBe("pass");
  });

  it("keeps Escape, Tab and the text field's own keys", () => {
    expect(editorKeyOutcome(key("Escape"), true)).toBe("keep");
    expect(editorKeyOutcome(key("Tab", { shiftKey: true }), true)).toBe("keep");
    expect(editorKeyOutcome(key("z", { metaKey: true, shiftKey: true }), true)).toBe("keep");
    expect(editorKeyOutcome(key("x", { ctrlKey: true }), false)).toBe("keep");
    expect(editorKeyOutcome(key("g", { ctrlKey: true }), true)).toBe("keep");
    expect(editorKeyOutcome(key("k", { altKey: true }), true)).toBe("keep");
    expect(editorKeyOutcome(key("a"), false)).toBe("keep");
  });
});

describe("indentUnit", () => {
  it("indents like the file does", () => {
    expect(indentUnit("a\n\tb\n\tc\n  d")).toBe("\t");
    expect(indentUnit("a\n  b\n")).toBe("  ");
  });
});
