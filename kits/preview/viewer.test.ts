import { describe, expect, it } from "vitest";
import { createMemoryStorage } from "../../src/workbench/client-storage.js";
import { DEFAULT_MINI_PREFS } from "./protocol.js";
import { DEVICE_MINI_PREFS_KEY, loadDeviceMiniPrefs, saveDeviceMiniPrefs } from "./mini-prefs.js";
import { describeViewer, viewerId } from "./viewer.js";

describe("this device, as the page is laid out for it", () => {
  it("keeps one id across reloads", () => {
    const storage = createMemoryStorage();
    const id = viewerId(storage);
    expect(id).toMatch(/^[0-9a-f]{24}$/u);
    expect(viewerId(storage)).toBe(id);
    storage.set("tau.preview.viewer-id", "given-id");
    expect(viewerId(storage)).toBe("given-id");
  });

  it("is the area it draws the page in, and keeps its height while the keyboard is up", () => {
    const first = describeViewer("p", { width: 377.4, height: 600.2 }, { dpr: 3, touch: true, keyboardOpen: false });
    expect(first).toEqual({ id: "p", width: 377, height: 600, dpr: 3, touch: true });
    expect(describeViewer("p", { width: 377, height: 290 }, { dpr: 3, touch: true, keyboardOpen: true }, first)).toMatchObject({ height: 600 });
    // Turned sideways with the keyboard up: a new width is a new screen.
    expect(describeViewer("p", { width: 800, height: 200 }, { dpr: 3, touch: true, keyboardOpen: true }, first)).toMatchObject({ width: 800, height: 200 });
    expect(describeViewer("p", { width: 0, height: 600 }, { dpr: 1, touch: false, keyboardOpen: false })).toBeUndefined();
  });
});

describe("the floating preview's place on this device", () => {
  it("starts where the host kept it and then stays this device's own", () => {
    const storage = createMemoryStorage();
    const host = { corner: "top-left" as const, width: 300 };
    expect(loadDeviceMiniPrefs(storage, host)).toEqual(host);
    saveDeviceMiniPrefs(storage, { corner: "bottom-left", width: 9_999 });
    expect(loadDeviceMiniPrefs(storage, host)).toEqual({ corner: "bottom-left", width: 560 });
    storage.set(DEVICE_MINI_PREFS_KEY, "not json");
    expect(loadDeviceMiniPrefs(storage, DEFAULT_MINI_PREFS)).toEqual(DEFAULT_MINI_PREFS);
    expect(loadDeviceMiniPrefs(undefined, host)).toEqual(host);
  });
});
