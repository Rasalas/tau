import { describe, expect, it, vi } from "vitest";
import {
  FRAME_DEFAULT_HEIGHT,
  FRAME_KEYDOWN_MESSAGE,
  FRAME_KEYS_MESSAGE,
  FRAME_MAX_HEIGHT,
  FRAME_MIN_HEIGHT,
  clampFrameHeight,
  frameAllowAttribute,
  frameContentSecurityPolicy,
  frameResponsePolicy,
  prepareFrameDocument,
  readFrameCsp,
  readFrameKeyDown,
  readFramePermissions,
} from "./sandbox-frame.js";

describe("frame policy", () => {
  it("never allows the host's own origin or eval, with or without declared origins", () => {
    for (const csp of [undefined, readFrameCsp({ resourceDomains: ["https://cdn.example.com"], connectDomains: ["https://api.example.com"] })]) {
      const policy = frameContentSecurityPolicy(csp);
      expect(policy).not.toContain("'self'");
      expect(policy).not.toContain("unsafe-eval");
      expect(policy).toContain("default-src 'none'");
      expect(policy).toContain("form-action 'none'");
      expect(policy).toContain("object-src 'none'");
    }
  });

  it("opens only the directives a declared origin belongs to", () => {
    const policy = frameContentSecurityPolicy(readFrameCsp({
      resourceDomains: ["https://cdn.example.com"],
      connectDomains: ["wss://live.example.com:8443"],
      frameDomains: ["https://embed.example.com"],
      baseUriDomains: ["https://base.example.com"],
    }));
    expect(policy).toContain("script-src 'unsafe-inline' https://cdn.example.com");
    expect(policy).toContain("img-src data: blob: https://cdn.example.com");
    expect(policy).toContain("connect-src wss://live.example.com:8443");
    expect(policy).toContain("frame-src https://embed.example.com");
    expect(policy).toContain("base-uri https://base.example.com");
    expect(frameContentSecurityPolicy(undefined)).toContain("connect-src 'none'; frame-src 'none'");
  });

  it("drops local network origins, including alternate loopback spellings", () => {
    const local = ["http://127.0.0.1:8080", "https://127.1", "ws://2130706433", "http://0x7f000001", "https://localhost", "https://foo.localhost", "https://192.168.1.2", "https://10.0.0.1", "https://172.16.0.1", "https://169.254.169.254", "https://printer.local"];
    expect(readFrameCsp({ connectDomains: [...local, "https://api.example.com"] })?.connectDomains).toEqual(["https://api.example.com"]);
    expect(readFrameCsp({ resourceDomains: local, frameDomains: local, baseUriDomains: local })).toBeUndefined();
    expect(frameContentSecurityPolicy({ connectDomains: local })).toContain("connect-src 'none'");
  });

  it("drops junk and caps each list at 32 origins", () => {
    const many = Array.from({ length: 40 }, (_, index) => `https://h${index}.example.com`);
    const csp = readFrameCsp({
      resourceDomains: ["*", "'self'", "https://ok.example.com/path", "https://a b.example.com", "javascript:alert(1)", "https://x.com; script-src *", 5, null, "https://*.example.com"],
      connectDomains: many,
      frameDomains: "https://example.com",
      baseUriDomains: [],
    });
    expect(csp?.resourceDomains).toEqual(["https://*.example.com"]);
    expect(csp?.connectDomains).toHaveLength(32);
    expect(csp?.frameDomains).toBeUndefined();
    expect(csp?.baseUriDomains).toBeUndefined();
    expect(readFrameCsp({ resourceDomains: ["nope"] })).toBeUndefined();
    expect(readFrameCsp("x")).toBeUndefined();
    expect(readFrameCsp([])).toBeUndefined();
  });

  it("serves the sandbox without same-origin beside the app policy", () => {
    const header = frameResponsePolicy(undefined);
    expect(header.startsWith("sandbox allow-scripts allow-forms; default-src 'none'")).toBe(true);
    expect(header).not.toContain("allow-same-origin");
  });
});

describe("frame permissions", () => {
  it("keeps only known permissions as objects and names them in the allow attribute", () => {
    const permissions = readFramePermissions({ camera: {}, clipboardWrite: {}, microphone: true, usb: {}, geolocation: [] });
    expect(permissions).toEqual({ camera: {}, clipboardWrite: {} });
    expect(frameAllowAttribute(permissions)).toBe("camera; clipboard-write");
    expect(frameAllowAttribute(readFramePermissions({ microphone: {}, geolocation: {} }))).toBe("microphone; geolocation");
    expect(frameAllowAttribute(undefined)).toBe("");
    expect(readFramePermissions({})).toBeUndefined();
    expect(readFramePermissions(null)).toBeUndefined();
  });
});

describe("frame document", () => {
  const order = (html: string, needles: string[]) => needles.map((needle) => html.indexOf(needle));
  const sorted = (values: number[]) => values.every((value, index) => value >= 0 && (index === 0 || value > values[index - 1]!));

  it("puts the doctype, the policy meta, the scheme script, the cookie guard and then the app, in that order", () => {
    const html = prepareFrameDocument("<!DOCTYPE html><html><body>app-body</body></html>", { colorScheme: "dark" });
    expect(html.startsWith("<!DOCTYPE html><meta http-equiv=\"Content-Security-Policy\"")).toBe(true);
    expect(sorted(order(html, ["<!DOCTYPE html>", "<meta http-equiv", "colorScheme=\"dark\"", "document.cookie", "<html>"]))).toBe(true);
    expect(html.indexOf("<script>")).toBeGreaterThan(html.indexOf("<meta"));
  });

  it("adds a doctype to a document without one and keeps one it has once", () => {
    const bare = prepareFrameDocument("<p>hi</p>", {});
    expect(bare.startsWith("<!doctype html><meta")).toBe(true);
    expect(bare).toContain("colorScheme=\"light\"");
    expect(bare.endsWith("<p>hi</p>")).toBe(true);
    const withBom = prepareFrameDocument("﻿  <!doctype html5><p>x</p>", {});
    expect(withBom.match(/<!doctype/giu)).toHaveLength(1);
  });

  it("drops malformed origins before writing the policy into the meta tag", () => {
    const html = prepareFrameDocument("<p></p>", { csp: { resourceDomains: ['https://a.example.com"><script>x</script>'] } });
    expect(html).not.toContain('"><script>x');
    expect(html).toContain("script-src 'unsafe-inline'");
  });
});

describe("frame height", () => {
  it("clamps to the range and falls back for numbers that are not finite", () => {
    expect(clampFrameHeight(10)).toBe(FRAME_MIN_HEIGHT);
    expect(clampFrameHeight(99999)).toBe(FRAME_MAX_HEIGHT);
    expect(clampFrameHeight(250.6)).toBe(251);
    expect(clampFrameHeight(Number.NaN)).toBe(FRAME_DEFAULT_HEIGHT);
    expect(clampFrameHeight(Number.POSITIVE_INFINITY)).toBe(FRAME_DEFAULT_HEIGHT);
  });
});

describe("frame keys", () => {
  it("reads a passed-on key and nothing else", () => {
    const key = { type: FRAME_KEYDOWN_MESSAGE, key: "k", code: "KeyK", metaKey: true };
    expect(readFrameKeyDown(key)).toEqual({ key: "k", code: "KeyK", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, repeat: false });
    expect(readFrameKeyDown({ ...key, ctrlKey: "yes" })?.ctrlKey).toBe(false);
    expect(readFrameKeyDown({ ...key, key: 1 })).toBeUndefined();
    expect(readFrameKeyDown({ ...key, key: "" })).toBeUndefined();
    expect(readFrameKeyDown({ ...key, key: "k".repeat(33) })).toBeUndefined();
    expect(readFrameKeyDown({ ...key, type: "ui/open-link" })).toBeUndefined();
    expect(readFrameKeyDown(null)).toBeUndefined();
    expect(readFrameKeyDown("tau-sandbox-frame:keydown")).toBeUndefined();
  });

  it("puts the key script behind the scheme script and ahead of the app", () => {
    const html = prepareFrameDocument("<p>app</p>", {});
    const at = (needle: string) => html.indexOf(needle);
    expect(at("colorScheme=")).toBeGreaterThan(0);
    expect(at(FRAME_KEYDOWN_MESSAGE)).toBeGreaterThan(at("colorScheme="));
    expect(at("document.cookie")).toBeGreaterThan(at(FRAME_KEYDOWN_MESSAGE));
    expect(at("<p>app</p>")).toBeGreaterThan(at("document.cookie"));
  });
});

/** The key script run against a stand-in window, with the capture and bubble order a browser dispatches in. */
function keyedDocument() {
  const html = prepareFrameDocument("<p></p>", {});
  const code = [...html.matchAll(/<script>([^]*?)<\/script>/gu)].map((match) => match[1]!).find((script) => script.includes(FRAME_KEYDOWN_MESSAGE))!;
  const listeners: Array<{ type: string; fn: (event: any) => void; capture: boolean }> = [];
  const timers: Array<() => void> = [];
  const parent = { postMessage: vi.fn() };
  const page = {
    parent,
    addEventListener: (type: string, fn: (event: any) => void, capture?: boolean) => { listeners.push({ type, fn, capture: capture === true }); },
    removeEventListener: (type: string, fn: (event: any) => void) => {
      const at = listeners.findIndex((entry) => entry.type === type && entry.fn === fn);
      if (at >= 0) listeners.splice(at, 1);
    },
  };
  new Function("window", "setTimeout", code)(page, (run: () => void) => timers.push(run));
  const dispatch = (type: string, event: object) => {
    for (const entry of listeners.filter((candidate) => candidate.type === type && candidate.capture)) entry.fn(event);
    for (const entry of listeners.filter((candidate) => candidate.type === type && !candidate.capture)) entry.fn(event);
    timers.splice(0).forEach((run) => run());
  };
  const name = (chords: unknown, source: unknown = parent) => dispatch("message", { source, data: { type: FRAME_KEYS_MESSAGE, chords } });
  const press = (init: Record<string, unknown> = {}, target: object = { tagName: "BODY" }) => {
    const event = {
      isTrusted: true, isComposing: false, keyCode: 0, key: "k", code: "KeyK", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, repeat: false,
      defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, getModifierState: () => false, composedPath: () => [target], ...init,
    };
    dispatch("keydown", event);
    return event;
  };
  return { parent, page, listeners, name, press };
}

const chord = (key: string, init: Record<string, unknown> = {}) => ({ key, metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, ...init });

describe("frame key script", () => {
  it("passes on a named chord, keeps it from the browser and sends the key", () => {
    const frame = keyedDocument();
    frame.name([chord("k")]);
    const event = frame.press();
    expect(event.defaultPrevented).toBe(true);
    expect(frame.parent.postMessage).toHaveBeenCalledExactlyOnceWith(
      { type: FRAME_KEYDOWN_MESSAGE, key: "k", code: "KeyK", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, repeat: false },
      "*",
    );
    expect(frame.listeners.filter((entry) => entry.type === "keydown" && !entry.capture)).toEqual([]);
  });

  it("matches punctuation and digits by position, as the app does", () => {
    const frame = keyedDocument();
    frame.name([chord("]", { shiftKey: true }), chord("1", { altKey: true }), chord("j", { altKey: true })]);
    frame.press({ key: "}", code: "BracketRight", shiftKey: true });
    frame.press({ key: "¡", code: "Digit1", altKey: true });
    frame.press({ key: "∆", code: "KeyJ", altKey: true });
    expect(frame.parent.postMessage).toHaveBeenCalledTimes(3);
  });

  it("leaves every other key to the page", () => {
    const frame = keyedDocument();
    frame.press();
    frame.name([chord("k")]);
    const kept = [
      frame.press({ key: "c", code: "KeyC" }),
      frame.press({ metaKey: false }),
      frame.press({ metaKey: false, ctrlKey: true }),
      frame.press({ shiftKey: true }),
      frame.press({ isTrusted: false }),
      frame.press({ isComposing: true }),
      frame.press({ keyCode: 229 }),
      frame.press({}, { tagName: "TEXTAREA" }),
      frame.press({}, { tagName: "INPUT" }),
      frame.press({}, { tagName: "DIV", isContentEditable: true }),
    ];
    expect(kept.every((event) => !event.defaultPrevented)).toBe(true);
    expect(frame.parent.postMessage).not.toHaveBeenCalled();
  });

  it("does not pass on a key the page handled, and hears the parent only", () => {
    const frame = keyedDocument();
    frame.name([chord("k")], { not: "the parent" });
    frame.press();
    expect(frame.parent.postMessage).not.toHaveBeenCalled();
    frame.name([chord("k")]);
    frame.page.addEventListener("keydown", (event: { preventDefault(): void }) => event.preventDefault());
    frame.press();
    expect(frame.parent.postMessage).not.toHaveBeenCalled();
  });
});
