/**
 * What a thread's runtime says about its shortcuts. `HostThread.shortcuts` and
 * `runShortcut` speak this, so it is core's vocabulary, not a kit's; the kit
 * that surfaces the shortcuts carries its own wire types.
 */

/** Pi chord spellings the user set in `~/.pi/agent/keybindings.json`, by Pi action id. */
export type PiUserKeybindings = Record<string, string | string[] | undefined>;

/** A shortcut a Pi extension registered with `registerShortcut`. */
export interface PiShortcut {
  /** Pi chord spelling, lowercased, e.g. "ctrl+shift+p". */
  keys: string;
  description?: string;
  /** The extension file that registered it. */
  source: string;
}
