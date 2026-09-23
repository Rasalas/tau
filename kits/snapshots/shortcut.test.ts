import { describe, expect, it } from "vitest";
import { acceleratorFromKey, formatAccelerator, isAccelerator, shortcutConflict } from "./shortcut.js";

const press = (code: string, modifiers: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) =>
  ({ code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...modifiers });

describe("the SnapShot shortcut", () => {
  it("records a chord from the key's code, ⌘ on a Mac and Ctrl elsewhere as CommandOrControl", () => {
    expect(acceleratorFromKey(press("Digit2", { metaKey: true, shiftKey: true }), true)).toBe("CommandOrControl+Shift+2");
    // ⌥2 types ™ on a Mac; the code still says 2.
    expect(acceleratorFromKey(press("Digit2", { altKey: true, ctrlKey: true }), true)).toBe("Control+Alt+2");
    expect(acceleratorFromKey(press("KeyS", { ctrlKey: true, altKey: true }), false)).toBe("CommandOrControl+Alt+S");
    expect(acceleratorFromKey(press("F19", { metaKey: true }), false)).toBe("Super+F19");
    expect(acceleratorFromKey(press("ArrowUp", { metaKey: true }), true)).toBe("CommandOrControl+Up");
  });

  it("waits while only modifiers or Shift alone are down", () => {
    expect(acceleratorFromKey(press("ShiftLeft", { shiftKey: true }), true)).toBeUndefined();
    expect(acceleratorFromKey(press("KeyA", { shiftKey: true }), true)).toBeUndefined();
    expect(acceleratorFromKey(press("KeyA"), true)).toBeUndefined();
    expect(acceleratorFromKey(press("IntlBackslash", { metaKey: true }), true)).toBeUndefined();
  });

  it("accepts only accelerators Electron can register", () => {
    for (const good of ["CommandOrControl+Shift+2", "Control+Alt+F19", "Alt+Space", "CmdOrCtrl+Plus", "Super+/"]) expect(isAccelerator(good), good).toBe(true);
    for (const bad of ["Shift+2", "2", "CommandOrControl+", "Hyper+2", "CommandOrControl+Shift+Ö", 42, undefined]) expect(isAccelerator(bad), String(bad)).toBe(false);
  });

  it("reads like the platform's own shortcuts", () => {
    expect(formatAccelerator("CommandOrControl+Shift+2", true)).toBe("⌘⇧2");
    expect(formatAccelerator("Control+Alt+Plus", true)).toBe("⌃⌥+");
    expect(formatAccelerator("CommandOrControl+Shift+2", false)).toBe("Ctrl+Shift+2");
  });

  it("warns about chords every app already uses", () => {
    expect(shortcutConflict("CommandOrControl+C")).toMatch(/Copy/u);
    expect(shortcutConflict("Control+C")).toMatch(/Terminals/u);
    expect(shortcutConflict("CommandOrControl+Shift+2")).toBeUndefined();
  });
});
