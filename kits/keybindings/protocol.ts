/**
 * Keybindings' contract between its host entry and its desktop entry. The host
 * side reads Pi's `keybindings.json` and asks the thread's runtime which
 * shortcuts its Pi extensions registered; the desktop side turns both into
 * chords and palette commands of the workbench.
 */
export const KEYBINDINGS_HOST_EXTENSION_ID = "tau.keybindings";

/**
 * The chords the user set in `~/.pi/agent/keybindings.json`, by Pi action or
 * Tau command id. An entry written as `{ "key": …, "when": … }` (Tau only; Pi
 * skips it) carries its own `when` clause.
 */
export interface PiKeybindingsState {
  bindings: Record<string, Array<string | UserKeybinding>>;
}

export interface UserKeybinding {
  key: string;
  when?: string;
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
