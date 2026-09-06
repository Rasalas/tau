/**
 * Keybindings' contract between its host entry and its desktop entry. The host
 * side reads Pi's `keybindings.json` and asks the thread's runtime which
 * shortcuts its Pi extensions registered; the desktop side turns both into
 * chords and palette commands of the workbench.
 */
export const KEYBINDINGS_HOST_EXTENSION_ID = "tau.keybindings";

/** Pi chord spellings the user set in `~/.pi/agent/keybindings.json`, by Pi action id. */
export interface PiKeybindingsState {
  bindings: Record<string, string[]>;
}

/** A shortcut a Pi extension registered for a thread's runtime. */
export interface PiShortcut {
  /** Pi chord spelling, lowercased, e.g. "ctrl+shift+p". */
  keys: string;
  description?: string;
  /** The extension file that registered it. */
  source: string;
}

export interface PiShortcutsState {
  sessionId?: string;
  shortcuts: PiShortcut[];
}

export interface KeybindingsHostCommands {
  "pi-keybindings": { input: undefined; output: PiKeybindingsState };
  "shortcuts": { input: { sessionId?: string } | undefined; output: PiShortcutsState };
  "run-shortcut": { input: { keys: string; sessionId?: string }; output: undefined };
}
