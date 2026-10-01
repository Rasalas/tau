import { useSyncExternalStore } from "react";
import { Button, SegmentedControl, SettingRow, SettingsSection, TextField, useSetting, type PreferencesStore, type SettingsPageProps } from "tau";
import { TERMINAL_HOST_EXTENSION_ID, TERMINAL_PLACEMENT_SETTING, type TerminalPlacement } from "./protocol.js";

/** What the Settings search finds on the page; each id is a row's anchor. */
export const TERMINAL_SETTINGS_ROWS = [
  { id: "setting-terminal-placement", label: "Show the terminal in", keywords: ["dock", "drawer", "panel", "bottom", "layout", "placement"] },
  { id: "setting-terminal-font", label: "Font", keywords: ["terminal font", "font size", "ghostty", "monospace"] },
];

const PLACEMENTS: ReadonlyArray<{ value: TerminalPlacement; label: string }> = [
  { value: "dock", label: "Dock" },
  { value: "drawer", label: "Drawer" },
];

/** Where the terminal sits. Its font is a row of Settings → Appearance, through `tau.terminal/font`. */
export function TerminalSettingsPage({ preferences, onOpenSettings }: SettingsPageProps & { preferences: PreferencesStore }) {
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
        control={<SegmentedControl label="Show the terminal in" value={placement.value} options={PLACEMENTS} onChange={placement.set} />}
      />
      <SettingRow
        id="setting-terminal-font"
        title="Font"
        description="The terminal's font and size are under Appearance → Typography. Left empty, they follow your Ghostty config."
        control={onOpenSettings ? <Button onClick={() => onOpenSettings("appearance#setting-appearance-terminal-font")}>Open in Appearance</Button> : undefined}
      />
    </SettingsSection>
  </div>;
}

/** Connections' This machine card (design 2h): the shell a terminal starts, the user's own unless set. */
export function ShellRow() {
    const shell = useSetting<string>(`values.${TERMINAL_HOST_EXTENSION_ID}.shell`, { defaultValue: "", read: (raw) => (typeof raw === "string" ? raw : undefined) });
    return (
      <SettingRow id="setting-shell" title="Shell" description="terminals start" setting={shell}
        control={<TextField label="Shell" mono placeholder="Login shell" value={shell.value} onCommit={(draft) => {
          const next = draft.trim();
          if (next === shell.value) return;
          if (next) shell.set(next);
          else shell.reset();
        }} />} />
    );
}
