import { useSyncExternalStore } from "react";
import type { PreferencesStore, SettingsPageProps } from "tau";
import { TERMINAL_HOST_EXTENSION_ID, TERMINAL_PLACEMENT_SETTING, terminalPlacement, type TerminalPlacement } from "./protocol.js";

const PLACEMENTS: ReadonlyArray<{ value: TerminalPlacement; label: string }> = [
  { value: "dock", label: "Dock" },
  { value: "drawer", label: "Drawer" },
];

/** Where the terminal sits. Its font is a row of Settings → Appearance, through `tau.terminal/font`. */
export function TerminalSettingsPage({ preferences }: SettingsPageProps & { preferences: PreferencesStore }) {
  useSyncExternalStore(preferences.subscribe, preferences.getSnapshot);
  const placement = terminalPlacement(preferences.value(TERMINAL_HOST_EXTENSION_ID, TERMINAL_PLACEMENT_SETTING));

  return <div className="settings-page terminal-settings">
    <h3>Terminal</h3>
    <div className="settings-label">Show the terminal in</div>
    <div className="segmented" role="group" aria-label="Show the terminal in">
      {PLACEMENTS.map((entry) => <button key={entry.value} type="button" className={entry.value === placement ? "active" : ""} aria-pressed={entry.value === placement} onClick={() => preferences.setValue(TERMINAL_HOST_EXTENSION_ID, TERMINAL_PLACEMENT_SETTING, entry.value)}>{entry.label}</button>)}
    </div>
    <p className="settings-note">The dock is the panel on the right. The drawer sits below the conversation, full width, and keeps its height.</p>
    <p className="settings-note">The terminal&rsquo;s font and size are under Appearance → Typography. Left empty, they follow your Ghostty config.</p>
  </div>;
}
