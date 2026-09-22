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
  it("answers T3's terminal chords in the panel, with ⌘ on macOS and Ctrl elsewhere", () => {
    expect(terminalKeyOutcome(key("meta+d"), true, "panel")).toBe("split-right");
    expect(terminalKeyOutcome(key("meta+shift+D"), true, "panel")).toBe("split-down");
    expect(terminalKeyOutcome(key("meta+n"), true, "panel")).toBe("new");
    expect(terminalKeyOutcome(key("meta+w"), true, "panel")).toBe("close");
    expect(terminalKeyOutcome(key("meta+]"), true, "panel")).toBe("focus-next");
    expect(terminalKeyOutcome(key("meta+["), true, "panel")).toBe("focus-previous");
    expect(terminalKeyOutcome(key("ctrl+d"), false, "panel")).toBe("split-right");
  });

  it("leaves Ctrl chords to the shell on macOS, where they are the shell's", () => {
    expect(terminalKeyOutcome(key("ctrl+d"), true, "panel")).toBeUndefined();
    expect(terminalKeyOutcome(key("ctrl+c"), true, "panel")).toBeUndefined();
    expect(terminalKeyOutcome(key("ctrl+w"), true, "stage")).toBeUndefined();
    expect(terminalKeyOutcome(key("x"), true, "panel")).toBeUndefined();
  });

  it("gives the window what a shell does not read", () => {
    expect(terminalKeyOutcome(key("ctrl+Tab"), true, "panel")).toBe("pass");
    expect(terminalKeyOutcome(key("ctrl+shift+Tab"), false, "panel")).toBe("pass");
    expect(terminalKeyOutcome(key("meta+j"), true, "panel")).toBe("pass");
    expect(terminalKeyOutcome(key("meta+k"), true, "stage")).toBe("pass");
    expect(terminalKeyOutcome(key("ctrl+k"), false, "panel")).toBeUndefined();
  });

  it("on the stage, closes the tab through the window and swallows splits", () => {
    expect(terminalKeyOutcome(key("meta+w"), true, "stage")).toBe("pass");
    expect(terminalKeyOutcome(key("meta+d"), true, "stage")).toBe("ignore");
    expect(terminalKeyOutcome(key("meta+shift+d"), true, "stage")).toBe("ignore");
  });

  it("only looks at keydown", () => {
    expect(terminalKeyOutcome(key("meta+d", "keyup"), true, "panel")).toBeUndefined();
    expect(terminalKeyOutcome(key("meta+alt+d"), true, "panel")).toBe("pass");
  });
});
