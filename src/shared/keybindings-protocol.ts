/**
 * Wire between the Runtime Controls extension and its host entry, which
 * reads Pi's keybindings.json and the shortcuts Pi extensions registered.
 */
export const KEYBINDINGS_HOST_EXTENSION_ID = "tau.runtime-settings";

/** Pi chord spellings the user set in `~/.pi/agent/keybindings.json`, by Pi action id. */
export interface PiKeybindingsState {
  bindings: Record<string, string[]>;
}

/** A shortcut a Pi extension registered with `registerShortcut`. */
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

export type PiUserKeybindings = Record<string, string | string[] | undefined>;
