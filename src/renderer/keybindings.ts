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
  const raw = keys.trim().toLowerCase();
  // "mod++" binds the plus key itself.
  const parts = (raw.endsWith("++") ? [...raw.slice(0, -2).split("+"), "+"] : raw === "+" ? ["+"] : raw.split("+")).map((part) => part.trim());
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

/** The keys a chord presses on one platform: `mod+p` and `ctrl+p` are one chord off macOS. */
export function platformChordId(chord: KeyChord, mac = isMacPlatform()): string {
  const meta = chord.meta || (chord.mod && mac);
  const ctrl = chord.ctrl || (chord.mod && !mac);
  return [ctrl && "ctrl", meta && "meta", chord.alt && "alt", chord.shift && "shift", chord.key].filter(Boolean).join("+");
}

export function isModified(chord: KeyChord): boolean {
  return chord.mod || chord.ctrl || chord.alt || chord.meta;
}

export function isMacPlatform(platform = typeof navigator === "undefined" ? "" : navigator.platform): boolean {
  return /mac|iphone|ipad/iu.test(platform);
}

/** Punctuation and digits by position, so ⇧ or a layout that moves them still finds `mod+shift+]`. */
const CODE_KEYS: Record<string, string> = {
  Backquote: "`", Backslash: "\\", BracketLeft: "[", BracketRight: "]", Comma: ",", Equal: "=", Minus: "-",
  Period: ".", Quote: "'", Semicolon: ";", Slash: "/",
};

function eventKeys(event: KeyboardEvent, chord: KeyChord): string[] {
  const keys = [event.key.toLowerCase()];
  const code = event.code ?? "";
  const physical = CODE_KEYS[code] ?? /^Digit(\d)$/u.exec(code)?.[1];
  if (physical) keys.push(physical);
  // On macOS Option turns J into ∆, so an alt chord also matches by the physical letter.
  const letter = /^Key([A-Z])$/u.exec(code)?.[1];
  if (letter && chord.alt) keys.push(letter.toLowerCase());
  return keys;
}

export function chordMatchesEvent(chord: KeyChord, event: KeyboardEvent, mac = isMacPlatform()): boolean {
  // AltGr types characters on Windows and Linux; a chord never takes them.
  if (!mac && event.getModifierState?.("AltGraph") && !/^[a-z0-9]$/iu.test(event.key)) return false;
  if (!eventKeys(event, chord).includes(chord.key)) return false;
  const wantsMeta = chord.meta || (chord.mod && mac);
  const wantsCtrl = chord.ctrl || (chord.mod && !mac);
  return event.metaKey === wantsMeta && event.ctrlKey === wantsCtrl && event.altKey === chord.alt && event.shiftKey === chord.shift;
}

/** Keys a keydown reports that are not a key to bind on their own. */
const MODIFIER_KEYS = new Set(["shift", "control", "alt", "altgraph", "meta", "os", "capslock", "fn", "dead", "process", "unidentified"]);

/**
 * The chord a keydown presses, spelled for keybindings.json (`mod+shift+k`),
 * or undefined for a modifier alone or a key that only types. Digits,
 * punctuation and ⌥-letters are read by position, as `chordMatchesEvent` does.
 */
export function chordFromKeyboardEvent(event: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">, mac = isMacPlatform()): string | undefined {
  const typed = event.key.toLowerCase();
  if (!typed || MODIFIER_KEYS.has(typed)) return undefined;
  const code = event.code ?? "";
  const letter = /^Key([A-Z])$/u.exec(code)?.[1]?.toLowerCase();
  let key = CODE_KEYS[code] ?? /^Digit(\d)$/u.exec(code)?.[1] ?? (letter && (event.altKey || !/^[a-z]$/u.test(typed)) ? letter : typed);
  if (key === " " || key === "spacebar") key = "space";
  const mod = mac ? event.metaKey : event.ctrlKey;
  const ctrl = mac && event.ctrlKey;
  const meta = !mac && event.metaKey;
  const named = key.length > 1;
  // A bare or ⇧-only printable key types text; a function key alone is fine.
  if (!mod && !ctrl && !meta && !event.altKey && !(named && (event.shiftKey || /^f\d{1,2}$/u.test(key)))) return undefined;
  return [mod && "mod", ctrl && "ctrl", meta && "meta", event.altKey && "alt", event.shiftKey && "shift", key].filter(Boolean).join("+");
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
