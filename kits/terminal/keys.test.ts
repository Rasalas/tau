import { describe, expect, it } from "vitest";
import { terminalKeyOutcome, type KeyLike } from "./keys.js";

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
