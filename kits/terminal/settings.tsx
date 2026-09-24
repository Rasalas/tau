import { useSyncExternalStore } from "react";
import { SettingRow, SettingsSection, useSetting, type PreferencesStore, type SettingsPageProps } from "tau";
import { TERMINAL_HOST_EXTENSION_ID, TERMINAL_PLACEMENT_SETTING, type TerminalPlacement } from "./protocol.js";

const PLACEMENTS: ReadonlyArray<{ value: TerminalPlacement; label: string }> = [
  { value: "dock", label: "Dock" },
  { value: "drawer", label: "Drawer" },
];

/** Where the terminal sits. Its font is a row of Settings → Appearance, through `tau.terminal/font`. */
export function TerminalSettingsPage({ preferences }: SettingsPageProps & { preferences: PreferencesStore }) {
  useSyncExternalStore(preferences.subscribe, preferences.getSnapshot);
  const placement = useSetting<TerminalPlacement>(`values.${TERMINAL_HOST_EXTENSION_ID}.${TERMINAL_PLACEMENT_SETTING}`, {
    defaultValue: "dock",
    read: (raw) => (raw === "dock" || raw === "drawer" ? raw : undefined),
    format: (value) => (value === "drawer" ? "Drawer" : "Dock"),
    offline: (value) => preferences.setValue(TERMINAL_HOST_EXTENSION_ID, TERMINAL_PLACEMENT_SETTING, value),
  });

  return <div className="settings-page terminal-settings">
    <h3>Terminal</h3>
    <SettingsSection title="Layout">
      <SettingRow
        id="setting-terminal-placement"
        title="Show the terminal in"
        description="The dock is the panel on the right. The drawer sits below the conversation, full width, and keeps its height."
        setting={placement}
        control={<div className="segmented" role="group" aria-label="Show the terminal in">
          {PLACEMENTS.map((entry) => <button key={entry.value} type="button" className={entry.value === placement.value ? "active" : ""} aria-pressed={entry.value === placement.value} onClick={() => placement.set(entry.value)}>{entry.label}</button>)}
        </div>}
      />
      <SettingRow
        id="setting-terminal-font"
        title="Font"
        description="The terminal's font and size are under Appearance → Typography. Left empty, they follow your Ghostty config."
      />
    </SettingsSection>
  </div>;
}
