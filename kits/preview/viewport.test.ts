import { describe, expect, it } from "vitest";
import { DEFAULT_PREVIEW_DEFAULTS, fitViewport, previewChord, readDefaults, readViewport, stepZoom, viewportLabel } from "./viewport.js";

const key = (name: string, modifiers: Partial<{ meta: boolean; control: boolean; shift: boolean; alt: boolean }> = {}) =>
  ({ type: "keyDown", key: name, meta: false, control: false, shift: false, alt: false, ...modifiers });

describe("the page's zoom", () => {
  it("steps along Chrome's ladder and stops at its ends", () => {
    expect(stepZoom(1, "in")).toBe(1.1);
    expect(stepZoom(1, "out")).toBe(0.9);
    expect(stepZoom(1.05, "in")).toBe(1.1);
    expect(stepZoom(1.05, "out")).toBe(1);
    expect(stepZoom(5, "in")).toBe(5);
    expect(stepZoom(0.25, "out")).toBe(0.25);
    expect(stepZoom(3, "reset")).toBe(1);
  });
});

describe("viewports", () => {
  it("reads fill, presets, sizes and nothing else", () => {
    expect(readViewport("fill")).toEqual({ mode: "fill" });
    expect(readViewport("iphone-12-pro")).toEqual({ mode: "fixed", width: 390, height: 844, preset: "iphone-12-pro" });
    expect(readViewport({ mode: "preset", preset: "iphone-12-pro", orientation: "landscape" })).toEqual({ mode: "fixed", width: 844, height: 390, preset: "iphone-12-pro" });
    expect(readViewport({ mode: "freeform", width: 1024.4, height: 768 })).toEqual({ mode: "fixed", width: 1024, height: 768 });
    expect(readViewport("800x600")).toEqual({ mode: "fixed", width: 800, height: 600 });
    expect(readViewport({ mode: "fixed", width: 100, height: 768 })).toBeUndefined();
    expect(readViewport({ mode: "preset", preset: "nokia-3310" })).toBeUndefined();
    expect(readViewport({ mode: "fixed", width: "1024", height: 768 })).toBeUndefined();
    expect(viewportLabel({ mode: "fixed", width: 390, height: 844, preset: "iphone-12-pro" })).toBe("iPhone 12 Pro · 390×844");
  });

  it("fills the panel at the user's zoom", () => {
    const panel = { x: 10, y: 20, width: 600, height: 400 };
    expect(fitViewport(panel, { mode: "fill" }, 1.25)).toEqual({ rect: panel, zoom: 1.25 });
  });

  it("keeps a fixed viewport's CSS size by scaling the view and the page together", () => {
    const panel = { x: 0, y: 0, width: 600, height: 1000 };
    const fitted = fitViewport(panel, { mode: "fixed", width: 1200, height: 800 }, 1);
    expect(fitted.zoom).toBe(0.5);
    expect(fitted.rect).toEqual({ x: 0, y: 0, width: 600, height: 400 });
    // What the page measures: the view's pixels over its zoom.
    expect(fitted.rect.width / fitted.zoom).toBe(1200);
    // Room to spare: the view is centred and never larger than the user's zoom.
    const phone = fitViewport(panel, { mode: "fixed", width: 390, height: 844 }, 1);
    expect(phone).toEqual({ rect: { x: 105, y: 0, width: 390, height: 844 }, zoom: 1 });
    expect(fitViewport(panel, { mode: "fixed", width: 390, height: 844 }, 0.5).rect.width).toBe(195);
  });
});

describe("the page's chords", () => {
  it("takes ⌘R, ⇧⌘R and the zoom chords on macOS", () => {
    expect(previewChord(key("r", { meta: true }), "darwin")).toBe("reload");
    expect(previewChord(key("R", { meta: true, shift: true }), "darwin")).toBe("hard-reload");
    expect(previewChord(key("=", { meta: true }), "darwin")).toBe("zoom-in");
    expect(previewChord(key("+", { meta: true, shift: true }), "darwin")).toBe("zoom-in");
    expect(previewChord(key("-", { meta: true }), "darwin")).toBe("zoom-out");
    expect(previewChord(key("0", { meta: true }), "darwin")).toBe("zoom-reset");
  });

  it("leaves every other key to the page", () => {
    expect(previewChord(key("r"), "darwin")).toBeUndefined();
    expect(previewChord(key("r", { control: true }), "darwin")).toBeUndefined();
    expect(previewChord(key("0", { meta: true, alt: true }), "darwin")).toBeUndefined();
    expect(previewChord(key("-", { meta: true, shift: true }), "darwin")).toBeUndefined();
    expect(previewChord({ ...key("r", { meta: true }), type: "keyUp" }, "darwin")).toBeUndefined();
    expect(previewChord(key("l", { meta: true }), "darwin")).toBeUndefined();
  });

  it("uses Ctrl off macOS", () => {
    expect(previewChord(key("r", { control: true }), "win32")).toBe("reload");
    expect(previewChord(key("r", { meta: true }), "linux")).toBeUndefined();
  });
});

describe("defaults", () => {
  it("reads Settings' strings and falls back field by field", () => {
    expect(readDefaults(undefined)).toEqual(DEFAULT_PREVIEW_DEFAULTS);
    expect(readDefaults({ viewport: "iphone-se", zoom: "1.25", appearance: "dark", recording: { frameRate: "60", showKeys: true } })).toEqual({
      viewport: { mode: "fixed", width: 375, height: 667, preset: "iphone-se" },
      zoom: 1.25,
      appearance: "dark",
      recording: { frameRate: 60, showKeys: true, showClicks: false },
    });
    expect(readDefaults({ zoom: "huge", appearance: "sepia", recording: { frameRate: 24 } })).toEqual(DEFAULT_PREVIEW_DEFAULTS);
  });
});
