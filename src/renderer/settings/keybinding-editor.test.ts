import { describe, expect, it } from "vitest";
import { ExtensionRegistry } from "../extension-system";
import { chordsAfterEdit, keybindingSource, pressesKeys, userChord, whenError, whenSuggestions } from "./keybinding-editor";

function registry() {
  const keys = new ExtensionRegistry();
  keys.activate({ id: "core", name: "Core", activate(context) {
    context.registerKeybinding({ keys: "mod+n", commandId: "new-thread", when: "!terminalFocus" });
    context.registerKeybinding({ keys: "mod+shift+o", commandId: "new-thread", when: "!terminalFocus" });
    context.registerKeybinding({ keys: "mod+d", commandId: "split", when: "terminalFocus" });
  } });
  return keys;
}

describe("the keybinding editor's rules", () => {
  it("writes a chord without when where it keeps the default's clause", () => {
    expect(userChord("mod+t", "!terminalFocus", "!terminalFocus")).toEqual({ key: "mod+t" });
    expect(userChord("mod+t", "", undefined)).toEqual({ key: "mod+t" });
    expect(userChord("mod+t", "true", undefined)).toEqual({ key: "mod+t" });
    // Everywhere, although the default only applies in a context.
    expect(userChord("mod+t", "", "!terminalFocus")).toEqual({ key: "mod+t", when: "true" });
    expect(userChord("mod+t", " composerFocus ", "!terminalFocus")).toEqual({ key: "mod+t", when: "composerFocus" });
  });

  it("swaps, adds and removes one chord of a command and keeps the others", () => {
    const keys = registry();
    const live = keys.getKeybindings();
    const [first, second] = live.filter((binding) => binding.commandId === "new-thread");
    expect(chordsAfterEdit(live, "new-thread", "!terminalFocus", { target: first, next: { key: "mod+t", when: "!terminalFocus" } })).toEqual([{ key: "mod+t" }, { key: "mod+shift+o" }]);
    expect(chordsAfterEdit(live, "new-thread", "!terminalFocus", { next: { key: "mod+t", when: "" } })).toEqual([{ key: "mod+n" }, { key: "mod+shift+o" }, { key: "mod+t", when: "true" }]);
    expect(chordsAfterEdit(live, "new-thread", "!terminalFocus", { target: second })).toEqual([{ key: "mod+n" }]);
    // The same chord twice is written once.
    expect(chordsAfterEdit(live, "new-thread", "!terminalFocus", { target: second, next: { key: "mod+n", when: "!terminalFocus" } })).toEqual([{ key: "mod+n" }]);
    const split = live.find((binding) => binding.commandId === "split");
    expect(chordsAfterEdit(live, "split", "terminalFocus", { target: split })).toBeUndefined();
  });

  it("leaves chords from config.json out of what it writes", () => {
    const keys = registry();
    keys.applyKeybindingOverrides({ split: "mod+e" });
    const live = keys.getKeybindings();
    const override = live.find((binding) => binding.commandId === "split")!;
    expect(keybindingSource(override)).toBe("config");
    expect(chordsAfterEdit(live, "split", "terminalFocus", { next: { key: "mod+g", when: "terminalFocus" } })).toEqual([{ key: "mod+g" }]);
  });

  it("tells a default from a chord the user set", () => {
    const keys = registry();
    keys.activate({ id: "file", name: "File", activate(context) {
      context.registerKeybinding({ keys: "mod+t", commandId: "new-thread", replaces: "new-thread" });
    } });
    expect(keys.getKeybindings().map((binding) => [binding.keys, keybindingSource(binding)])).toEqual([["mod+d", "default"], ["mod+t", "custom"]]);
  });

  it("checks a clause, suggests the contexts in use, and finds chords by the keys pressed", () => {
    expect(whenError("")).toBeUndefined();
    expect(whenError("terminalFocus && !stageFocus")).toBeUndefined();
    expect(whenError("terminalFocus &&")).toMatch(/context names/u);
    const suggestions = whenSuggestions(registry().getKeybindings());
    expect(suggestions).toContain("terminalFocus");
    expect(suggestions).toContain("!terminalFocus");
    expect(suggestions).toContain("composerFocus");
    expect(suggestions).not.toContain("true");
    expect(pressesKeys({ keys: "mod+p" }, "ctrl+p", false)).toBe(true);
    expect(pressesKeys({ keys: "mod+p" }, "ctrl+p", true)).toBe(false);
    expect(pressesKeys({ keys: "mod+shift+p" }, "mod+p", true)).toBe(false);
  });
});
