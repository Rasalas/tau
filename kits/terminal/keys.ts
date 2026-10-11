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

/** What the terminal does itself with a navigation chord (T3 #17091). */
export type TerminalNavigation = "select-all" | "scroll-to-top" | "scroll-to-bottom";

/**
 * Select all and the jumps through the scrollback. On macOS they are the
 * system's own ⌘A and ⌘Home/⌘End; elsewhere Ctrl+A and Home/End belong to the
 * shell, so they take Shift as well. A full-screen program keeps Home and End.
 */
export function terminalNavigation(event: KeyLike, mac: boolean, alternateScreen: boolean): TerminalNavigation | undefined {
  if (event.type !== "keydown" || event.altKey) return undefined;
  const primary = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey && event.shiftKey;
  if (!primary) return undefined;
  if (event.key.toLowerCase() === "a") return mac && event.shiftKey ? undefined : "select-all";
  if (alternateScreen) return undefined;
  if (event.key === "Home") return "scroll-to-top";
  return event.key === "End" ? "scroll-to-bottom" : undefined;
}
