const isMac = () => typeof navigator !== "undefined" && /mac|iphone|ipad/iu.test(navigator.platform);

/** The key a page chord is held with: ⌘ on macOS, Ctrl elsewhere. */
export const pageModifier = (mac = isMac()): string => (mac ? "⌘" : "Ctrl");

const KEY_WORDS: Record<string, string> = { "+": "Plus", "−": "Minus" };

/**
 * A chord the page itself answers (⌘R, ⌘0, ⌘+): `previewChord` reads them
 * from the view's keys, so no command or binding names them for a hint.
 */
export function pageChord(key: string, mac = isMac()): string {
  return mac ? `⌘${key}` : `Ctrl+${KEY_WORDS[key] ?? key}`;
}
