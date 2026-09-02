import { describe, expect, it } from "vitest";
import { chordMatchesEvent, formatKeyChord, isModified, normalizeKeyChord, parseKeyChord } from "./keybindings";

const event = (init: Partial<KeyboardEvent> & { key: string }) =>
  ({ metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...init }) as KeyboardEvent;

describe("key chords", () => {
  it("parses Pi spellings and the platform modifier", () => {
    expect(parseKeyChord("ctrl+shift+P")).toMatchObject({ key: "p", ctrl: true, shift: true, mod: false });
    expect(parseKeyChord("esc")).toMatchObject({ key: "escape" });
    expect(parseKeyChord("Mod+K")).toMatchObject({ key: "k", mod: true });
    expect(parseKeyChord("super+up")).toMatchObject({ key: "arrowup", meta: true });
    expect(parseKeyChord("ctrl+")).toBeUndefined();
    expect(parseKeyChord("bogus+k")).toBeUndefined();
    expect(parseKeyChord("ctrl+shift")).toBeUndefined();
  });

  it("normalises modifier order so equal chords collide", () => {
    expect(normalizeKeyChord("shift+ctrl+s")).toBe("ctrl+shift+s");
    expect(normalizeKeyChord("Ctrl+Shift+S")).toBe("ctrl+shift+s");
    expect(normalizeKeyChord("return")).toBe("enter");
    expect(isModified(parseKeyChord("escape")!)).toBe(false);
    expect(isModified(parseKeyChord("mod+n")!)).toBe(true);
  });

  it("matches events per platform", () => {
    const chord = parseKeyChord("mod+shift+s")!;
    expect(chordMatchesEvent(chord, event({ key: "S", metaKey: true, shiftKey: true }), true)).toBe(true);
    expect(chordMatchesEvent(chord, event({ key: "S", ctrlKey: true, shiftKey: true }), true)).toBe(false);
    expect(chordMatchesEvent(chord, event({ key: "S", ctrlKey: true, shiftKey: true }), false)).toBe(true);
    expect(chordMatchesEvent(parseKeyChord("escape")!, event({ key: "Escape" }), true)).toBe(true);
    expect(chordMatchesEvent(parseKeyChord("escape")!, event({ key: "Escape", metaKey: true }), true)).toBe(false);
    expect(chordMatchesEvent(parseKeyChord("ctrl+l")!, event({ key: "l", ctrlKey: true }), true)).toBe(true);
  });

  it("formats chords the way each platform writes them", () => {
    expect(formatKeyChord(parseKeyChord("mod+shift+s")!, true)).toBe("⇧⌘S");
    expect(formatKeyChord(parseKeyChord("mod+shift+s")!, false)).toBe("Ctrl+Shift+S");
    expect(formatKeyChord(parseKeyChord("escape")!, true)).toBe("Esc");
    expect(formatKeyChord(parseKeyChord("ctrl+l")!, true)).toBe("⌃L");
    expect(formatKeyChord(parseKeyChord("alt+enter")!, false)).toBe("Alt+↵");
  });
});
