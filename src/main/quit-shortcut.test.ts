import { describe, expect, it } from "vitest";
import { QUIT_DOUBLE_PRESS_MS, QUIT_HOLD_MS, QUIT_RELEASE_QUIET_MS, createQuitShortcut, type QuitKeyInput } from "./quit-shortcut.js";
import type { QuitConfirmation } from "../shared/window-shell.js";

/** A clock and a timer queue the test moves by hand. */
function harness(mode: QuitConfirmation = "hold", platform = "darwin") {
  let time = 1_000;
  let timers: Array<{ at: number; run: () => void }> = [];
  const hints: string[] = [];
  let quits = 0;
  let concealed = 0;
  let current = mode;
  const handle = createQuitShortcut({
    platform,
    mode: () => current,
    hint: (event) => hints.push(event.state === "down" ? `down:${event.mode}` : "up"),
    conceal: () => { concealed += 1; },
    quit: () => { quits += 1; },
    now: () => time,
    schedule: (run, ms) => {
      const timer = { at: time + ms, run };
      timers.push(timer);
      return () => { timers = timers.filter((entry) => entry !== timer); };
    },
  });
  const press = (key: string, options: Partial<QuitKeyInput> = {}) => {
    let prevented = false;
    const modifier = platform === "darwin" ? { meta: true } : { control: true };
    handle({ preventDefault: () => { prevented = true; } }, { type: "keyDown", key, meta: false, control: false, alt: false, shift: false, isAutoRepeat: false, ...modifier, ...options });
    return prevented;
  };
  const release = (key: string) => handle({ preventDefault: () => undefined }, { type: "keyUp", key, meta: false, control: false, alt: false, shift: false, isAutoRepeat: false });
  const advance = (ms: number) => {
    time += ms;
    for (const timer of timers.filter((entry) => entry.at <= time)) {
      timers = timers.filter((entry) => entry !== timer);
      timer.run();
    }
  };
  return {
    press, release, advance, hints,
    setMode: (next: QuitConfirmation) => { current = next; },
    get quits() { return quits; },
    get concealed() { return concealed; },
  };
}

describe("the quit shortcut", () => {
  it("quits once ⌘Q was held, after the key is let go", () => {
    const keys = harness("hold");
    expect(keys.press("q")).toBe(true);
    expect(keys.hints).toEqual(["down:hold"]);
    keys.advance(500);
    keys.press("q", { isAutoRepeat: true });
    expect(keys.quits).toBe(0);
    keys.advance(QUIT_HOLD_MS - 500);
    keys.press("q", { isAutoRepeat: true });
    expect(keys.concealed).toBe(1);
    expect(keys.quits).toBe(0);
    keys.release("q");
    expect(keys.quits).toBe(1);
    expect(keys.hints).toEqual(["down:hold", "up"]);
  });

  it("quits after a quiet moment when macOS swallows the key-up", () => {
    const keys = harness("hold");
    keys.press("q");
    keys.advance(QUIT_HOLD_MS);
    keys.press("q", { isAutoRepeat: true });
    keys.advance(QUIT_RELEASE_QUIET_MS - 1);
    keys.press("q", { isAutoRepeat: true });
    keys.advance(QUIT_RELEASE_QUIET_MS - 1);
    expect(keys.quits).toBe(0);
    keys.advance(1);
    expect(keys.quits).toBe(1);
  });

  it("does not quit on a tap, and hides the hint when no repeat follows", () => {
    const keys = harness("hold");
    keys.press("q");
    keys.advance(QUIT_HOLD_MS + QUIT_RELEASE_QUIET_MS);
    expect(keys.quits).toBe(0);
    expect(keys.hints).toEqual(["down:hold", "up"]);
  });

  it("quits on two quick presses in either mode", () => {
    for (const mode of ["hold", "double-press"] as const) {
      const keys = harness(mode);
      keys.press("q");
      keys.release("q");
      keys.advance(QUIT_DOUBLE_PRESS_MS - 100);
      keys.press("q");
      expect(keys.quits).toBe(1);
    }
  });

  it("asks for the second press again when it came too late", () => {
    const keys = harness("double-press");
    keys.press("q");
    keys.advance(QUIT_DOUBLE_PRESS_MS + 1);
    expect(keys.hints).toEqual(["down:double-press", "up"]);
    keys.press("q");
    expect(keys.quits).toBe(0);
  });

  it("quits at once when confirmation is off, read on every press", () => {
    const keys = harness("hold");
    keys.setMode("off");
    expect(keys.press("q")).toBe(true);
    expect(keys.quits).toBe(1);
    expect(keys.hints).toEqual([]);
  });

  it("leaves other chords alone and lets another key cancel", () => {
    const keys = harness("double-press");
    expect(keys.press("q", { meta: false })).toBe(false);
    expect(keys.press("q", { shift: true })).toBe(false);
    keys.press("q");
    expect(keys.press("w")).toBe(false);
    keys.press("q");
    expect(keys.quits).toBe(0);
  });

  it("uses Ctrl outside macOS", () => {
    const keys = harness("off", "win32");
    expect(keys.press("q", { control: false, meta: true })).toBe(false);
    keys.press("q");
    expect(keys.quits).toBe(1);
  });
});
