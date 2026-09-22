/**
 * Key chords for workbench keybindings. Spelling follows Pi's keybindings.json
 * ("ctrl+shift+p", "escape", "alt+enter") plus "mod" for the platform's
 * primary modifier: ⌘ on macOS, Ctrl elsewhere.
 */
export interface KeyChord {
  /** Normalised key name as `KeyboardEvent.key` reports it, lowercased. */
  key: string;
  mod: boolean;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
}

const KEY_ALIASES: Record<string, string> = {
  esc: "escape",
  return: "enter",
  up: "arrowup",
  down: "arrowdown",
  left: "arrowleft",
  right: "arrowright",
  pageup: "pageup",
  pagedown: "pagedown",
  space: " ",
  del: "delete",
};

const MODIFIERS: Record<string, keyof Omit<KeyChord, "key">> = {
  mod: "mod",
  ctrl: "ctrl",
  control: "ctrl",
  shift: "shift",
  alt: "alt",
  option: "alt",
  meta: "meta",
  cmd: "meta",
  command: "meta",
  super: "meta",
};

export function parseKeyChord(keys: string): KeyChord | undefined {
  const parts = keys.trim().toLowerCase().split("+").map((part) => part.trim());
  if (parts.length === 0 || parts.some((part) => !part)) return undefined;
  const chord: KeyChord = { key: "", mod: false, ctrl: false, shift: false, alt: false, meta: false };
  for (const part of parts.slice(0, -1)) {
    const modifier = MODIFIERS[part];
    if (!modifier) return undefined;
    chord[modifier] = true;
  }
  const last = parts.at(-1)!;
  if (MODIFIERS[last]) return undefined;
  chord.key = KEY_ALIASES[last] ?? last;
  return chord;
}

/** Same chord, same spelling: what the registry keys its bindings by. */
export function normalizeKeyChord(keys: string): string | undefined {
  const chord = parseKeyChord(keys);
  if (!chord) return undefined;
  const parts = [chord.mod && "mod", chord.ctrl && "ctrl", chord.meta && "meta", chord.alt && "alt", chord.shift && "shift"].filter(Boolean);
  return [...parts, chord.key].join("+");
}

export function isModified(chord: KeyChord): boolean {
  return chord.mod || chord.ctrl || chord.alt || chord.meta;
}

export function isMacPlatform(platform = typeof navigator === "undefined" ? "" : navigator.platform): boolean {
  return /mac|iphone|ipad/iu.test(platform);
}

export function chordMatchesEvent(chord: KeyChord, event: KeyboardEvent, mac = isMacPlatform()): boolean {
  const key = event.key.toLowerCase();
  // On macOS Option turns J into ∆, so an alt chord also matches by the physical key.
  if (key !== chord.key && !(chord.alt && event.code?.replace(/^Key|^Digit/u, "").toLowerCase() === chord.key)) return false;
  const wantsMeta = chord.meta || (chord.mod && mac);
  const wantsCtrl = chord.ctrl || (chord.mod && !mac);
  return event.metaKey === wantsMeta && event.ctrlKey === wantsCtrl && event.altKey === chord.alt && event.shiftKey === chord.shift;
}

const KEY_LABELS: Record<string, string> = {
  escape: "Esc",
  enter: "↵",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  backspace: "⌫",
  delete: "⌦",
  tab: "⇥",
  " ": "Space",
};

/** How the palette and settings show a chord: ⌘⇧S on macOS, Ctrl+Shift+S elsewhere. */
export function formatKeyChord(chord: KeyChord, mac = isMacPlatform()): string {
  const key = KEY_LABELS[chord.key] ?? (chord.key.length === 1 ? chord.key.toUpperCase() : chord.key[0]!.toUpperCase() + chord.key.slice(1));
  if (mac) {
    return [
      chord.ctrl ? "⌃" : "",
      chord.alt ? "⌥" : "",
      chord.shift ? "⇧" : "",
      chord.mod || chord.meta ? "⌘" : "",
      key,
    ].join("");
  }
  return [
    chord.mod || chord.ctrl ? "Ctrl" : "",
    chord.meta ? "Win" : "",
    chord.alt ? "Alt" : "",
    chord.shift ? "Shift" : "",
    key,
  ].filter(Boolean).join("+");
}
