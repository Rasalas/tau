import { describe, expect, it, vi } from "vitest";
import { backgroundModeRequested, installBackgroundMode, type BackgroundWindowPrototype } from "./background-mode.js";

describe("background mode", () => {
  it("is on for TAU_NO_FOCUS=1 unless TAU_FOREGROUND=1, and off for the installed app", () => {
    expect(backgroundModeRequested({ TAU_NO_FOCUS: "1" })).toBe(true);
    expect(backgroundModeRequested({ TAU_NO_FOCUS: "1", TAU_FOREGROUND: "1" })).toBe(false);
    expect(backgroundModeRequested({})).toBe(false);
  });

  function fakes() {
    const calls: string[] = [];
    const app = { setActivationPolicy: vi.fn((policy: string) => { calls.push(`policy:${policy}`); }), focus: vi.fn((_options?: { steal: boolean }) => { calls.push("app.focus"); }) };
    class FakeWindow implements BackgroundWindowPrototype {
      show() { calls.push("show"); }
      showInactive() { calls.push("showInactive"); }
      focus() { calls.push("focus"); }
    }
    return { calls, app, FakeWindow };
  }

  it("turns show into showInactive and drops every focus request, including a steal", () => {
    const { calls, app, FakeWindow } = fakes();
    installBackgroundMode(app, FakeWindow.prototype, "darwin");
    const window = new FakeWindow();
    window.show();
    window.focus();
    app.focus({ steal: true });
    expect(calls).toEqual(["policy:accessory", "showInactive"]);
  });

  it("sets an activation policy only on macOS", () => {
    const { calls, app, FakeWindow } = fakes();
    installBackgroundMode(app, FakeWindow.prototype, "linux");
    new FakeWindow().show();
    expect(calls).toEqual(["showInactive"]);
  });
});
