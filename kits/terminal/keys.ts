/**
 * Which keys a focused terminal leaves to the window. The terminal's own
 * chords (split, new, close, pane focus) are ordinary keybindings under
 * `terminalFocus`, which the window runs before the shell sees the key; this
 * only decides what else the shell does not need.
 */

/** `pass` hands a keydown to the window's bindings; `undefined` keeps it for the shell. */
export type TerminalKeyOutcome = "pass" | undefined;

export interface KeyLike {
  type: string;
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export function terminalKeyOutcome(event: KeyLike, mac: boolean): TerminalKeyOutcome {
  if (event.type !== "keydown") return undefined;
  // Stage-tab switching must reach the window even from inside a shell.
  if (event.ctrlKey && !event.metaKey && !event.altKey && event.key === "Tab") return "pass";
  // A shell reads no ⌘ chord; on macOS all of them are the workbench's.
  if (mac && event.metaKey) return "pass";
  return undefined;
}
