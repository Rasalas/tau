import type { PreviewViewer } from "./protocol.js";

const VIEWER_ID_KEY = "tau.preview.viewer-id";

interface Storage {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

let sessionId: string | undefined;

const randomId = (): string => {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
};

/** This device's id for the page's layout: the same across reloads where the store keeps it. */
export function viewerId(storage: Storage | undefined): string {
  try {
    const stored = storage?.get(VIEWER_ID_KEY);
    if (stored && /^[A-Za-z0-9_-]{1,64}$/u.test(stored)) return stored;
    sessionId ??= randomId();
    storage?.set(VIEWER_ID_KEY, sessionId);
  } catch {
    sessionId ??= randomId();
  }
  return sessionId;
}

/**
 * The device as the host lays the page out for it: the area it draws the page
 * in. An open on-screen keyboard keeps the height it had, as a phone's browser
 * keeps the page's layout while its keyboard is up.
 */
export function describeViewer(
  id: string,
  box: { width: number; height: number },
  screen: { dpr: number; touch: boolean; keyboardOpen: boolean },
  previous?: PreviewViewer,
): PreviewViewer | undefined {
  if (box.width < 1 || box.height < 1) return undefined;
  const width = Math.round(box.width);
  const keep = screen.keyboardOpen && previous && previous.width === width;
  return {
    id,
    width,
    height: keep ? previous.height : Math.round(box.height),
    dpr: Math.round(Math.max(1, screen.dpr || 1) * 100) / 100,
    touch: screen.touch,
  };
}

/** What this screen is: its pixel ratio, whether its main pointer is a finger, whether a keyboard covers it. */
export function screenTraits(): { dpr: number; touch: boolean; keyboardOpen: boolean } {
  if (typeof window === "undefined") return { dpr: 1, touch: false, keyboardOpen: false };
  return {
    dpr: window.devicePixelRatio || 1,
    touch: typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches,
    keyboardOpen: document.body.dataset.keyboard !== undefined,
  };
}
