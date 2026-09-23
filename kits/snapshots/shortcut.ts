/** Electron accelerators for the global shortcut: recorded from a key, checked, and written for people. */

const MODIFIERS = ["CommandOrControl", "Command", "Control", "Alt", "Super", "Shift"] as const;
type Modifier = (typeof MODIFIERS)[number];

const NAMED_KEYS = new Set([
  "Space", "Tab", "Backspace", "Delete", "Insert", "Return", "Enter", "Up", "Down", "Left", "Right",
  "Home", "End", "PageUp", "PageDown", "Esc", "Escape", "Plus", "PrintScreen",
]);

/** `KeyboardEvent.code` → Electron's name for the key; the code, not the character, so ⌥ on a Mac does not turn `2` into `™`. */
function keyOfCode(code: string): string | undefined {
  let match = /^Key([A-Z])$/u.exec(code);
  if (match) return match[1];
  match = /^Digit(\d)$/u.exec(code);
  if (match) return match[1];
  match = /^F(\d{1,2})$/u.exec(code);
  if (match && Number(match[1]) >= 1 && Number(match[1]) <= 24) return code;
  const named: Record<string, string> = {
    Space: "Space", Tab: "Tab", Backspace: "Backspace", Delete: "Delete", Enter: "Return",
    ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
    Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
    Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\",
    Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/", Backquote: "`",
  };
  return named[code];
}

export interface KeyChord {
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * The accelerator a key press names, or undefined while it is only a modifier
 * or lacks one besides Shift (Shift alone is typing). ⌘ on a Mac and Ctrl
 * elsewhere become `CommandOrControl`.
 */
export function acceleratorFromKey(event: KeyChord, mac: boolean): string | undefined {
  const key = keyOfCode(event.code);
  if (!key) return undefined;
  const parts: Modifier[] = [];
  if (mac ? event.metaKey : event.ctrlKey) parts.push("CommandOrControl");
  if (mac && event.ctrlKey) parts.push("Control");
  if (!mac && event.metaKey) parts.push("Super");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  if (!parts.some((part) => part !== "Shift")) return undefined;
  return [...parts, key].join("+");
}

/** Whether Electron could register it: modifiers first, at least one besides Shift, one key last. */
export function isAccelerator(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parts = value.split("+");
  // `Plus` spells the plus key; a trailing `+` would split into an empty part.
  const key = parts.pop();
  if (!key || parts.length === 0) return false;
  if (!parts.every((part) => (MODIFIERS as readonly string[]).includes(part) || part === "Option" || part === "Ctrl" || part === "Cmd" || part === "CmdOrCtrl")) return false;
  if (!parts.some((part) => part !== "Shift")) return false;
  return /^[A-Z0-9]$/u.test(key) || /^F(?:[1-9]|1\d|2[0-4])$/u.test(key) || NAMED_KEYS.has(key) || /^[-=[\]\\;',./`]$/u.test(key);
}

const MAC_SYMBOLS: Record<string, string> = {
  CommandOrControl: "⌘", CmdOrCtrl: "⌘", Command: "⌘", Cmd: "⌘", Control: "⌃", Ctrl: "⌃", Alt: "⌥", Option: "⌥", Shift: "⇧", Super: "⌘",
};
const OTHER_NAMES: Record<string, string> = {
  CommandOrControl: "Ctrl", CmdOrCtrl: "Ctrl", Command: "Super", Cmd: "Super", Control: "Ctrl", Ctrl: "Ctrl", Alt: "Alt", Option: "Alt", Shift: "Shift", Super: "Super",
};

/** `CommandOrControl+Shift+2` → `⌘⇧2` on a Mac, `Ctrl+Shift+2` elsewhere. */
export function formatAccelerator(accelerator: string, mac: boolean): string {
  const parts = accelerator.split("+");
  const key = parts.pop() ?? "";
  const keyLabel = key === "Plus" ? "+" : key === "Space" ? "Space" : key;
  if (mac) return `${parts.map((part) => MAC_SYMBOLS[part] ?? part).join("")}${keyLabel}`;
  return [...parts.map((part) => OTHER_NAMES[part] ?? part), keyLabel].join("+");
}

const COMMON: Record<string, string> = {
  A: "Select All", C: "Copy", F: "Find", N: "New", O: "Open", P: "Print", Q: "Quit",
  S: "Save", T: "New Tab", V: "Paste", W: "Close", X: "Cut", Z: "Undo",
};

/** A warning when the chord is one every app already uses; the shortcut would take it from all of them. */
export function shortcutConflict(accelerator: string): string | undefined {
  const parts = accelerator.split("+");
  const key = parts.pop() ?? "";
  if (parts.length !== 1) return undefined;
  const [modifier] = parts;
  if ((modifier === "CommandOrControl" || modifier === "Command") && COMMON[key]) return `This is ${COMMON[key]} in most apps; a global shortcut would take it from all of them.`;
  if (modifier === "Control" && ["C", "D", "Z"].includes(key)) return "Terminals use this to control running commands.";
  if (modifier === "Alt" && key === "Tab") return "The system uses this to switch windows.";
  return undefined;
}
