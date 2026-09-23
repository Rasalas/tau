// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { POINTER_PATH, previewAgentCursor, previewAgentCursorClear, previewInputOverlay, previewInputOverlayEnd } from "./page-cursor.js";
import { pageCall } from "./page-script.js";

const timing = { activeMs: 700, labelMs: 1_600 };

/** The overlay's shadow root is closed, as in the page; the test reaches it through `attachShadow`. */
function captureShadows(): ShadowRoot[] {
  const roots: ShadowRoot[] = [];
  const original = Element.prototype.attachShadow;
  vi.spyOn(Element.prototype, "attachShadow").mockImplementation(function (this: Element, init: ShadowRootInit) {
    const root = original.call(this, init);
    roots.push(root);
    return root;
  });
  return roots;
}

afterEach(() => {
  previewAgentCursorClear();
  previewInputOverlayEnd();
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.documentElement.innerHTML = "<head></head><body></body>";
});

describe("the agent's cursor in the page", () => {
  it("travels as source text", () => {
    expect(pageCall(previewAgentCursor, { id: "a", kind: "click", x: 0.5, y: 0.5, failed: false }, timing, POINTER_PATH)).toContain("\"kind\":\"click\"");
  });

  it("draws the cursor where the action landed, fades it and shows typed text beside it", () => {
    vi.useFakeTimers();
    const roots = captureShadows();
    Object.assign(window, { innerWidth: 1000, innerHeight: 500 });
    previewAgentCursor({ id: "a", kind: "type", x: 0.25, y: 0.5, label: "hello", failed: false }, timing, POINTER_PATH);
    const host = document.querySelector("[data-tau-overlay='agent-cursor']") as HTMLElement;
    expect(host.getAttribute("aria-hidden")).toBe("true");
    expect(host.style.pointerEvents).toBe("none");
    const cursor = roots[0]!.querySelector("div") as HTMLElement;
    expect(cursor.style.left).toBe("250px");
    expect(cursor.style.top).toBe("250px");
    const label = [...roots[0]!.querySelectorAll("span")].find((span) => span.textContent === "hello")!;
    expect(label.style.display).toBe("block");
    vi.advanceTimersByTime(timing.activeMs);
    expect(cursor.style.opacity).toBe("0.35");
    vi.advanceTimersByTime(timing.labelMs);
    expect(label.style.display).toBe("none");
  });

  it("reuses its layer, and puts a chord without a place in the corner", () => {
    const roots = captureShadows();
    previewAgentCursor({ id: "a", kind: "click", x: 0.1, y: 0.1, failed: false }, timing, POINTER_PATH);
    previewAgentCursor({ id: "b", kind: "key", label: "↩", failed: false }, timing, POINTER_PATH);
    expect(document.querySelectorAll("[data-tau-overlay='agent-cursor']")).toHaveLength(1);
    const corner = [...roots[0]!.querySelectorAll("span")].find((span) => span.textContent === "↩")!;
    expect(corner.style.bottom).toBe("8px");
    expect(previewAgentCursorClear()).toBe(true);
    expect(document.querySelector("[data-tau-overlay]")).toBeNull();
  });
});

describe("the recording's input overlay", () => {
  it("shows keys and chords, but nothing typed into a password field", () => {
    const roots = captureShadows();
    document.body.innerHTML = "<input id='q'><input id='pw' type='password'>";
    previewInputOverlay({ keys: true, clicks: false }, POINTER_PATH);
    const keys = () => roots[0]!.querySelector("div") as HTMLElement;
    (document.getElementById("q") as HTMLInputElement).focus();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "b" }));
    expect(keys().textContent).toBe("AB");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(keys().textContent).toBe("↵");
    (document.getElementById("pw") as HTMLInputElement).focus();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "x" }));
    expect(keys().textContent).toBe("↵");
  });

  it("shows no keys unless asked, changes its options in place and leaves the page as it was", () => {
    const roots = captureShadows();
    previewInputOverlay({ keys: false, clicks: false }, POINTER_PATH);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    expect((roots[0]!.querySelector("div") as HTMLElement).style.display).toBe("none");
    previewInputOverlay({ keys: true, clicks: true }, POINTER_PATH);
    expect(document.querySelectorAll("[data-tau-overlay='recording-input']")).toHaveLength(1);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    expect((roots[0]!.querySelector("div") as HTMLElement).textContent).toBe("A");
    expect(previewInputOverlayEnd()).toBe(true);
    expect(document.querySelector("[data-tau-overlay]")).toBeNull();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "b" }));
    expect(previewInputOverlayEnd()).toBe(false);
  });

  it("draws its own pointer where the mouse is", () => {
    const roots = captureShadows();
    previewInputOverlay({ keys: false, clicks: true }, POINTER_PATH);
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 40, clientY: 30 }));
    const pointer = roots[0]!.querySelector("svg") as SVGElement;
    expect(pointer.style.display).toBe("block");
    expect(pointer.style.transform).toBe("translate(36px, 27px)");
    window.dispatchEvent(new MouseEvent("mousedown", { clientX: 40, clientY: 30 }));
    expect(roots[0]!.querySelectorAll("span")).toHaveLength(1);
  });
});
