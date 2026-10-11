import { describe, expect, it } from "vitest";
import { terminalKeyOutcome, terminalNavigation, type KeyLike } from "./keys.js";

const key = (chord: string, type = "keydown"): KeyLike => {
  const parts = chord.split("+");
  return {
    type,
    key: parts.at(-1)!,
    metaKey: parts.includes("meta"),
    ctrlKey: parts.includes("ctrl"),
    altKey: parts.includes("alt"),
    shiftKey: parts.includes("shift"),
  };
};

describe("terminalKeyOutcome", () => {
  it("hands every ⌘ chord to the window on macOS", () => {
    expect(terminalKeyOutcome(key("meta+d"), true)).toBe("pass");
    expect(terminalKeyOutcome(key("meta+shift+D"), true)).toBe("pass");
    expect(terminalKeyOutcome(key("meta+j"), true)).toBe("pass");
    expect(terminalKeyOutcome(key("meta+alt+d"), true)).toBe("pass");
  });

  it("leaves Ctrl chords to the shell, except stage-tab switching", () => {
    expect(terminalKeyOutcome(key("ctrl+d"), true)).toBeUndefined();
    expect(terminalKeyOutcome(key("ctrl+c"), true)).toBeUndefined();
    expect(terminalKeyOutcome(key("ctrl+k"), false)).toBeUndefined();
    expect(terminalKeyOutcome(key("x"), true)).toBeUndefined();
    expect(terminalKeyOutcome(key("ctrl+Tab"), true)).toBe("pass");
    expect(terminalKeyOutcome(key("ctrl+shift+Tab"), false)).toBe("pass");
  });

  it("ignores key-ups", () => {
    expect(terminalKeyOutcome(key("meta+d", "keyup"), true)).toBeUndefined();
  });
});

describe("terminalNavigation", () => {
  it("takes ⌘A and ⌘Home/⌘End on macOS, with or without Shift for the jumps", () => {
    expect(terminalNavigation(key("meta+a"), true, false)).toBe("select-all");
    expect(terminalNavigation(key("meta+Home"), true, false)).toBe("scroll-to-top");
    expect(terminalNavigation(key("meta+shift+End"), true, false)).toBe("scroll-to-bottom");
    expect(terminalNavigation(key("meta+shift+a"), true, false)).toBeUndefined();
  });

  it("leaves Ctrl+A and Ctrl+Home/End to the shell elsewhere, and takes them with Shift", () => {
    expect(terminalNavigation(key("ctrl+a"), false, false)).toBeUndefined();
    expect(terminalNavigation(key("ctrl+End"), false, false)).toBeUndefined();
    expect(terminalNavigation(key("ctrl+shift+A"), false, false)).toBe("select-all");
    expect(terminalNavigation(key("ctrl+shift+Home"), false, false)).toBe("scroll-to-top");
    expect(terminalNavigation(key("ctrl+shift+End"), false, false)).toBe("scroll-to-bottom");
  });

  it("keeps Home and End for a full-screen program, but not select all", () => {
    expect(terminalNavigation(key("meta+Home"), true, true)).toBeUndefined();
    expect(terminalNavigation(key("meta+a"), true, true)).toBe("select-all");
  });

  it("ignores other chords, Alt chords and key-ups", () => {
    expect(terminalNavigation(key("meta+d"), true, false)).toBeUndefined();
    expect(terminalNavigation(key("meta+alt+a"), true, false)).toBeUndefined();
    expect(terminalNavigation(key("ctrl+meta+a"), true, false)).toBeUndefined();
    expect(terminalNavigation(key("meta+a", "keyup"), true, false)).toBeUndefined();
    expect(terminalNavigation(key("PageUp"), true, false)).toBeUndefined();
  });
});
