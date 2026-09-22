import { describe, expect, it } from "vitest";
import { editorKeyOutcome, indentUnit, lineIndent, shiftLines, type KeyLike } from "./keys.js";

const key = (value: string, modifiers: Partial<KeyLike> = {}): KeyLike => ({ key: value, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...modifiers });

describe("editorKeyOutcome", () => {
  it("saves on mod+s before the window's stash binding hears it", () => {
    expect(editorKeyOutcome(key("s", { metaKey: true }), true)).toBe("save");
    expect(editorKeyOutcome(key("s", { ctrlKey: true }), false)).toBe("save");
    expect(editorKeyOutcome(key("S", { metaKey: true, shiftKey: true }), true)).toBe("pass");
  });

  it("keeps Escape from stopping the agent and indents with Tab", () => {
    expect(editorKeyOutcome(key("Escape"), true)).toBe("swallow");
    expect(editorKeyOutcome(key("Tab"), true)).toBe("indent");
    expect(editorKeyOutcome(key("Tab", { shiftKey: true }), true)).toBe("outdent");
    expect(editorKeyOutcome(key("Enter"), true)).toBe("newline");
    expect(editorKeyOutcome(key("Tab"), true, true)).not.toBe("indent");
  });

  it("lets the text field edit and the workbench keep its own chords", () => {
    expect(editorKeyOutcome(key("z", { metaKey: true, shiftKey: true }), true)).toBe("native");
    expect(editorKeyOutcome(key("x", { ctrlKey: true }), false)).toBe("native");
    expect(editorKeyOutcome(key("k", { ctrlKey: true }), true)).toBe("native");
    expect(editorKeyOutcome(key("k", { altKey: true }), true)).toBe("native");
    expect(editorKeyOutcome(key("a"), false)).toBe("native");
    expect(editorKeyOutcome(key("k", { metaKey: true }), true)).toBe("pass");
    expect(editorKeyOutcome(key("w", { ctrlKey: true }), false)).toBe("pass");
    expect(editorKeyOutcome(key("Tab", { ctrlKey: true }), true)).toBe("pass");
  });
});

describe("indentation", () => {
  it("indents like the file does", () => {
    expect(indentUnit("a\n\tb\n\tc\n  d")).toBe("\t");
    expect(indentUnit("a\n  b\n")).toBe("  ");
    expect(lineIndent("x\n    let a", 12)).toBe("    ");
  });

  it("shifts every line the selection touches and keeps the selection on them", () => {
    const text = "one\ntwo\nthree";
    expect(shiftLines(text, 1, 6, "  ", false)).toEqual({ text: "  one\n  two\nthree", start: 3, end: 10, from: 0, to: 7, replacement: "  one\n  two" });
    expect(shiftLines("  one\n  two\nthree", 3, 10, "  ", true)).toMatchObject({ text: "one\ntwo\nthree", start: 1, end: 6 });
    // A selection that ends at the start of a line leaves that line alone.
    expect(shiftLines(text, 0, 4, "\t", false).text).toBe("\tone\ntwo\nthree");
  });
});
