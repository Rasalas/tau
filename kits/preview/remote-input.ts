import { PREVIEW_INPUT_KEYS, type PreviewInput, type PreviewInputKey } from "./protocol.js";

/** Input as the page takes it: points in its CSS pixels. */
export type PreviewPageInput =
  | { kind: "click"; x: number; y: number }
  | { kind: "scroll"; x: number; y: number; dx: number; dy: number }
  | { kind: "text"; text: string }
  | { kind: "key"; key: string };

/** A paste of a long token is fine; a novel is not what a phone sends into a login form. */
export const MAX_INPUT_TEXT = 4_000;
/** A scroll moves at most this many frames' heights at once. */
const MAX_SCROLL = 10;

const fraction = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
const delta = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(-MAX_SCROLL, Math.min(MAX_SCROLL, value)) : 0;

/** What a device sent, checked field by field; anything else is refused with a reason. */
export function readPreviewInput(value: unknown): PreviewInput {
  const fields = value && typeof value === "object" ? value as Record<string, unknown> : {};
  switch (fields.kind) {
    case "click": {
      const x = fraction(fields.x), y = fraction(fields.y);
      if (x === undefined || y === undefined) throw new Error("A tap needs x and y between 0 and 1.");
      return { kind: "click", x, y };
    }
    case "scroll": {
      const x = fraction(fields.x) ?? 0.5, y = fraction(fields.y) ?? 0.5;
      return { kind: "scroll", x, y, dx: delta(fields.dx), dy: delta(fields.dy) };
    }
    case "text": {
      if (typeof fields.text !== "string" || !fields.text) throw new Error("Typing needs text.");
      if (fields.text.length > MAX_INPUT_TEXT) throw new Error(`Type at most ${String(MAX_INPUT_TEXT)} characters at once.`);
      return { kind: "text", text: fields.text };
    }
    case "key": {
      const key = PREVIEW_INPUT_KEYS.find((candidate) => candidate === fields.key);
      if (!key) throw new Error(`A device may send ${PREVIEW_INPUT_KEYS.join(", ")}.`);
      return { kind: "key", key };
    }
    default:
      throw new Error("Input is a click, a scroll, text or a key.");
  }
}

/** A tap at a fraction of the frame, as a point in the page's viewport. */
export function pageInput(input: PreviewInput, viewport: { width: number; height: number }): PreviewPageInput {
  if (input.kind !== "click" && input.kind !== "scroll") return input;
  const width = Math.max(0, viewport.width), height = Math.max(0, viewport.height);
  const x = Math.round(input.x * width);
  const y = Math.round(input.y * height);
  return input.kind === "click" ? { kind: "click", x, y } : { kind: "scroll", x, y, dx: Math.round(input.dx * width), dy: Math.round(input.dy * height) };
}

/** `code` and the Windows virtual key code Chromium wants for each key. */
const KEY_CODES: Record<PreviewInputKey, { code: string; vk: number; text?: string }> = {
  Enter: { code: "Enter", vk: 13, text: "\r" },
  Tab: { code: "Tab", vk: 9 },
  Backspace: { code: "Backspace", vk: 8 },
  Delete: { code: "Delete", vk: 46 },
  Escape: { code: "Escape", vk: 27 },
  ArrowUp: { code: "ArrowUp", vk: 38 },
  ArrowDown: { code: "ArrowDown", vk: 40 },
  ArrowLeft: { code: "ArrowLeft", vk: 37 },
  ArrowRight: { code: "ArrowRight", vk: 39 },
  Home: { code: "Home", vk: 36 },
  End: { code: "End", vk: 35 },
  PageUp: { code: "PageUp", vk: 33 },
  PageDown: { code: "PageDown", vk: 34 },
};

export type CdpCommand = [method: string, params: Record<string, unknown>];

/**
 * The DevTools protocol's input commands for one input. They are trusted
 * events and need neither a visible view nor the window's focus, so the
 * page on the host takes a phone's tap while the host's user works elsewhere.
 * `touch` when the page is laid out for a touch screen.
 */
export function cdpInputCommands(input: PreviewPageInput, options: { touch?: boolean } = {}): CdpCommand[] {
  switch (input.kind) {
    case "click": {
      const at = { x: input.x, y: input.y };
      // On a touch layout a tap is a touch, so the page's touch handlers see it; the page makes the click.
      if (options.touch) {
        return [
          ["Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [at] }],
          ["Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }],
        ];
      }
      return [
        ["Input.dispatchMouseEvent", { type: "mouseMoved", ...at }],
        ["Input.dispatchMouseEvent", { type: "mousePressed", ...at, button: "left", buttons: 1, clickCount: 1 }],
        ["Input.dispatchMouseEvent", { type: "mouseReleased", ...at, button: "left", buttons: 0, clickCount: 1 }],
      ];
    }
    case "scroll":
      return [["Input.dispatchMouseEvent", { type: "mouseWheel", x: input.x, y: input.y, deltaX: input.dx, deltaY: input.dy }]];
    case "text":
      return [["Input.insertText", { text: input.text }]];
    case "key": {
      const known = KEY_CODES[input.key as PreviewInputKey];
      const text = known?.text ?? (input.key.length === 1 ? input.key : undefined);
      const key = { key: input.key, ...(known ? { code: known.code, windowsVirtualKeyCode: known.vk, nativeVirtualKeyCode: known.vk } : {}) };
      return [
        ["Input.dispatchKeyEvent", text ? { type: "keyDown", ...key, text, unmodifiedText: text } : { type: "rawKeyDown", ...key }],
        ["Input.dispatchKeyEvent", { type: "keyUp", ...key }],
      ];
    }
  }
}

/**
 * Runs in the page's isolated world: what has the keyboard. A password or
 * one-time-code field, or a frame this world cannot look into, is a secret.
 */
export function previewFocusKind(): "secret" | "field" | "none" {
  let element: Element | null = document.activeElement;
  for (let depth = 0; element && depth < 16; depth += 1) {
    if (element instanceof HTMLIFrameElement || element instanceof HTMLFrameElement) {
      let inner: Document | null = null;
      try {
        inner = element.contentDocument;
      } catch {
        inner = null;
      }
      if (!inner) return "secret";
      element = inner.activeElement;
      continue;
    }
    const shadow = (element as HTMLElement).shadowRoot?.activeElement;
    if (shadow) {
      element = shadow;
      continue;
    }
    if (element instanceof HTMLInputElement) {
      const type = element.type.toLowerCase();
      const autocomplete = (element.getAttribute("autocomplete") ?? "").toLowerCase();
      if (type === "password" || /\b(?:one-time-code|current-password|new-password)\b/u.test(autocomplete)) return "secret";
      return ["button", "checkbox", "radio", "submit", "reset", "file", "image", "range", "color"].includes(type) ? "none" : "field";
    }
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) return "field";
    return (element as HTMLElement).isContentEditable ? "field" : "none";
  }
  return "none";
}
