import { describe, expect, it } from "vitest";
import {
  applyModifiers, arrowSequence, dragLines, compactFontSize, DEFAULT_COMPACT_FONT_SIZE, DEFAULT_TABLET_FONT_SIZE, isTabletScreen, cellAt, selectionRange, isTypedInput, MAX_COMPACT_FONT_SIZE, MIN_COMPACT_FONT_SIZE,
  stepCompactFontSize, TOUCH_KEYS, type TouchModifier,
} from "./touch-keys.js";

const armed = (...modifiers: TouchModifier[]) => new Set(modifiers);

describe("the compact key bar", () => {
  it("has the keys a phone keyboard lacks, in order", () => {
    expect(TOUCH_KEYS.map((key) => key.id)).toEqual(["esc", "ctrl", "alt", "tab", "up", "down", "left", "right", "tilde", "pipe", "slash", "dash", "paste"]);
  });

  it("sends arrows in the cursor mode the program asked for", () => {
    expect(arrowSequence("up", false)).toBe("\u001b[A");
    expect(arrowSequence("left", false)).toBe("\u001b[D");
    expect(arrowSequence("down", true)).toBe("\u001bOB");
  });
});

describe("applyModifiers", () => {
  it("leaves input alone with nothing armed", () => {
    expect(applyModifiers("c", armed())).toBe("c");
  });

  it("turns a letter into its control byte, whatever its case", () => {
    expect(applyModifiers("c", armed("ctrl"))).toBe("\u0003");
    expect(applyModifiers("D", armed("ctrl"))).toBe("\u0004");
    expect(applyModifiers("[", armed("ctrl"))).toBe("\u001b");
    expect(applyModifiers(" ", armed("ctrl"))).toBe("\u0000");
    expect(applyModifiers("?", armed("ctrl"))).toBe("\u007f");
  });

  it("applies Ctrl to the first key of a longer chunk only", () => {
    expect(applyModifiers("rm", armed("ctrl"))).toBe("\u0012m");
    expect(applyModifiers("1", armed("ctrl"))).toBe("1");
  });

  it("puts ESC before a key for Alt, and combines with Ctrl", () => {
    expect(applyModifiers("b", armed("alt"))).toBe("\u001bb");
    expect(applyModifiers("\u007f", armed("alt"))).toBe("\u001b\u007f");
    expect(applyModifiers("x", armed("ctrl", "alt"))).toBe("\u001b\u0018");
  });

  it("gives an arrow xterm's modified form, from either cursor mode", () => {
    expect(applyModifiers("\u001b[D", armed("ctrl"))).toBe("\u001b[1;5D");
    expect(applyModifiers("\u001bOC", armed("alt"))).toBe("\u001b[1;3C");
    expect(applyModifiers("\u001b[A", armed("ctrl", "alt"))).toBe("\u001b[1;7A");
  });

  it("keeps an armed modifier for typed input, not for xterm's answers to a program", () => {
    expect(isTypedInput("a")).toBe(true);
    expect(isTypedInput("\r")).toBe(true);
    expect(isTypedInput("\u001b[?1;2c")).toBe(false);
    expect(isTypedInput("")).toBe(false);
  });
});

describe("the compact text size", () => {
  it("reads the stored size, clamped, and falls back to the default", () => {
    expect(compactFontSize(undefined)).toBe(DEFAULT_COMPACT_FONT_SIZE);
    expect(compactFontSize("junk")).toBe(DEFAULT_COMPACT_FONT_SIZE);
    expect(compactFontSize("13")).toBe(13);
    expect(compactFontSize(undefined, true)).toBe(DEFAULT_TABLET_FONT_SIZE);
    expect(compactFontSize("10", true)).toBe(10);
    expect(compactFontSize("2")).toBe(MIN_COMPACT_FONT_SIZE);
    expect(compactFontSize("99")).toBe(MAX_COMPACT_FONT_SIZE);
  });

  it("steps by a point and stops at the ends", () => {
    expect(stepCompactFontSize(11, 1)).toBe(12);
    expect(stepCompactFontSize(MIN_COMPACT_FONT_SIZE, -1)).toBe(MIN_COMPACT_FONT_SIZE);
    expect(stepCompactFontSize(MAX_COMPACT_FONT_SIZE, 1)).toBe(MAX_COMPACT_FONT_SIZE);
  });
});

describe("dragLines", () => {
  it("scrolls a line per cell the finger moved, older lines for a pull down", () => {
    expect(dragLines(0, 30, 14)).toEqual({ lines: -2, carry: 2 });
    expect(dragLines(0, -15, 14)).toEqual({ lines: 1, carry: -1 });
  });

  it("carries what is left of a line to the next move", () => {
    const first = dragLines(0, 10, 14);
    expect(first.lines).toBe(0);
    expect(dragLines(first.carry, 5, 14)).toEqual({ lines: -1, carry: 1 });
  });

  it("scrolls nothing before the cell has a size", () => {
    expect(dragLines(0, 40, 0)).toEqual({ lines: 0, carry: 0 });
  });
});

describe("isTabletScreen", () => {
  it("tells a tablet's screen from a phone's in either orientation", () => {
    expect(isTabletScreen({ width: 820, height: 1180 })).toBe(true);
    expect(isTabletScreen({ width: 1133, height: 744 })).toBe(true);
    expect(isTabletScreen({ width: 852, height: 393 })).toBe(false);
    expect(isTabletScreen(undefined)).toBe(false);
  });
});

describe("selecting with a finger", () => {
  const box = { left: 10, top: 20, width: 800, height: 240 };
  const size = { cols: 80, rows: 24 };

  it("finds the cell under the finger, in buffer rows, and never outside the screen", () => {
    expect(cellAt({ x: 10, y: 20 }, box, size, 100)).toEqual({ col: 0, row: 100 });
    expect(cellAt({ x: 115, y: 55 }, box, size, 100)).toEqual({ col: 10, row: 103 });
    expect(cellAt({ x: 5000, y: -40 }, box, size, 0)).toEqual({ col: 79, row: 0 });
  });

  it("selects from the held cell to the finger, forwards or backwards", () => {
    expect(selectionRange({ col: 4, row: 2 }, { col: 6, row: 2 }, 80)).toEqual({ column: 4, row: 2, length: 3 });
    expect(selectionRange({ col: 6, row: 3 }, { col: 78, row: 2 }, 80)).toEqual({ column: 78, row: 2, length: 9 });
    expect(selectionRange({ col: 5, row: 5 }, { col: 5, row: 5 }, 80)).toEqual({ column: 5, row: 5, length: 1 });
  });
});

