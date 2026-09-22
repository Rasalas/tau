/**
 * Chords a focused terminal answers itself. Tau's keybindings have no focus
 * context, so these are not workbench bindings: the terminal's own key
 * handler takes them while it has the keyboard, and the window never sees
 * them. Everything else a shell does not need goes to the window.
 */

export type TerminalChordAction = "split-right" | "split-down" | "new" | "close" | "focus-next" | "focus-previous";

/** What a keydown in a focused terminal does: a terminal action, `pass` to the window, or `undefined` for the shell. */
export type TerminalKeyOutcome = TerminalChordAction | "pass" | "ignore" | undefined;

export interface KeyLike {
  type: string;
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** `mod+d`, `mod+shift+d`, `mod+n`, `mod+w` as T3 Code binds them under terminal focus, and `mod+]`/`mod+[` between panes. */
const CHORDS: Array<{ key: string; shift: boolean; action: TerminalChordAction }> = [
  { key: "d", shift: false, action: "split-right" },
  { key: "d", shift: true, action: "split-down" },
  { key: "n", shift: false, action: "new" },
  { key: "w", shift: false, action: "close" },
  { key: "]", shift: false, action: "focus-next" },
  { key: "[", shift: false, action: "focus-previous" },
];

/**
 * `place` is where the terminal is drawn: on the stage one shell fills the
 * tab, so a split has nowhere to go and `mod+w` is the stage's own close.
 */
export function terminalKeyOutcome(event: KeyLike, mac: boolean, place: "panel" | "stage"): TerminalKeyOutcome {
  if (event.type !== "keydown") return undefined;
  const mod = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (mod && !event.altKey) {
    const key = event.key.toLowerCase();
    const chord = CHORDS.find((entry) => entry.key === key && entry.shift === event.shiftKey);
    if (chord) {
      if (place === "panel") return chord.action;
      return chord.action === "close" ? "pass" : "ignore";
    }
  }
  // Stage-tab switching must reach the window even from inside a shell.
  if (event.ctrlKey && !event.metaKey && !event.altKey && event.key === "Tab") return "pass";
  // A shell reads no ⌘ chord; on macOS all of them are the workbench's.
  if (mac && event.metaKey) return "pass";
  return undefined;
}
