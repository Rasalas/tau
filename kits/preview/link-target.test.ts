// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { followLinkTarget, resolveLinkTarget } from "./link-target.js";
import { EMPTY_PREVIEW_STATE } from "./protocol.js";
import { enlargedWidth, miniPlayerShown, nearestCorner } from "./mini-player.js";
import { defaultsFromSettings } from "./settings.js";
import { DEFAULT_PREVIEW_DEFAULTS } from "./viewport.js";

afterEach(() => { document.body.innerHTML = ""; });

describe("where a link opens", () => {
  it("opens web links in the Preview only when asked, and never with ⌘ or Ctrl", () => {
    const plain = { metaKey: false, ctrlKey: false };
    expect(resolveLinkTarget("https://example.com", plain, "app")).toBe("app");
    expect(resolveLinkTarget("https://example.com", plain, "system")).toBe("system");
    expect(resolveLinkTarget("https://example.com", { metaKey: true, ctrlKey: false }, "app")).toBe("system");
    expect(resolveLinkTarget("mailto:a@b.c", plain, "app")).toBe("system");
    expect(resolveLinkTarget("not a url", plain, "app")).toBe("system");
  });

  it("takes plain clicks on links in a reply, and leaves every other click alone", () => {
    document.body.innerHTML = `<div class="markdown"><a id="in" href="https://example.com/a" target="_blank">a</a></div><a id="out" href="https://example.com/b">b</a>`;
    const open = vi.fn();
    let target: "app" | "system" = "app";
    const stop = followLinkTarget(() => target, open);
    const click = (id: string, init: MouseEventInit = {}) => {
      const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init });
      document.getElementById(id)!.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(click("in")).toBe(true);
    expect(open).toHaveBeenCalledWith("https://example.com/a");
    expect(click("out")).toBe(false);
    expect(click("in", { metaKey: true })).toBe(false);
    target = "system";
    expect(click("in")).toBe(false);
    stop();
    target = "app";
    expect(click("in")).toBe(false);
    expect(open).toHaveBeenCalledTimes(1);
  });
});

describe("the floating preview", () => {
  const driven = { ...EMPTY_PREVIEW_STATE, url: "http://localhost:3000/", driver: { threadId: "t1", source: "browser" as const, since: 1 } };

  it("shows while an agent drives and the panel is out of sight", () => {
    const options = { enabled: true, panelShown: false, screen: false };
    expect(miniPlayerShown(driven, options)?.threadId).toBe("t1");
    expect(miniPlayerShown(driven, { ...options, panelShown: true })).toBeUndefined();
    expect(miniPlayerShown(driven, { ...options, enabled: false })).toBeUndefined();
    expect(miniPlayerShown({ ...driven, driver: { ...driven.driver, dismissed: true } }, options)).toBeUndefined();
    expect(miniPlayerShown({ ...driven, url: "" }, options)).toBeUndefined();
    expect(miniPlayerShown({ ...driven, driver: undefined }, options)).toBeUndefined();
    const screen = { ...driven, driver: { threadId: "t2", source: "screen" as const, since: 1 } };
    expect(miniPlayerShown(screen, options)).toBeUndefined();
    expect(miniPlayerShown(screen, { ...options, screen: true })?.threadId).toBe("t2");
  });

  it("snaps to the corner nearest where it was let go", () => {
    const area = { top: 60, left: 260, right: 20, bottom: 200, width: 1280, height: 1000 };
    expect(nearestCorner({ x: 400, y: 100 }, area)).toBe("top-left");
    expect(nearestCorner({ x: 1200, y: 700 }, area)).toBe("bottom-right");
    expect(nearestCorner({ x: 1000, y: 200 }, area)).toBe("top-right");
  });

  it("grows on hover to a readable size the chat column still holds", () => {
    const insets = { top: 60, left: 270, right: 20, bottom: 200 };
    expect(enlargedWidth(280, 1.6, insets, { width: 1280, height: 1000 })).toBe(700);
    // A narrow column caps it; it never shrinks below its resting width.
    expect(enlargedWidth(280, 1.6, insets, { width: 700, height: 1000 })).toBe(410);
    expect(enlargedWidth(280, 1.6, insets, { width: 500, height: 1000 })).toBe(280);
    // A tall picture is capped by the height above the composer.
    expect(enlargedWidth(280, 0.5, insets, { width: 1280, height: 1000 })).toBe(357);
  });
});

describe("Settings → Preview", () => {
  it("reads the defaults from the kit's own settings, as the host answers them", () => {
    expect(defaultsFromSettings({ values: { "default-viewport": "iphone-se", "default-zoom": "1.5" }, options: { "recording-keys": true } }))
      .toMatchObject({ viewport: { mode: "fixed", width: 375 }, zoom: 1.5, recording: { showKeys: true, showClicks: false } });
    expect(defaultsFromSettings({ values: {}, options: {} })).toEqual(DEFAULT_PREVIEW_DEFAULTS);
  });
});
