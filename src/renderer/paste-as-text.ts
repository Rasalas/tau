/**
 * "Paste as Text": the next paste within a moment skips what the composer
 * would make of it (a folded file, a chip) and lands as plain text. The chord
 * arms it from the keydown; the menu item arms it before the window's process
 * pastes. A deadline covers both orders and never leaves later pastes plain.
 */
const ARMED_MS = 1_000;
let armedUntil = 0;

export function armPasteAsText(now = Date.now()): void {
  armedUntil = now + ARMED_MS;
}

export function disarmPasteAsText(): void {
  armedUntil = 0;
}

/** Whether this paste is one; asking uses it up. */
export function takePasteAsText(now = Date.now()): boolean {
  const armed = now <= armedUntil;
  armedUntil = 0;
  return armed;
}

/** ⇧⌘V on macOS, Ctrl+Shift+V elsewhere. */
export function isPasteAsTextChord(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">, mac: boolean): boolean {
  return event.key.toLowerCase() === "v" && event.shiftKey && !event.altKey && (mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey);
}
