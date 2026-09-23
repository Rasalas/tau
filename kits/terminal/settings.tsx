import { useEffect, useSyncExternalStore } from "react";
import type { PreferencesStore, SettingsPageProps } from "tau";
import { FONT_FAMILY_SETTING, FONT_SIZE_SETTING, type TerminalFontSource } from "./font.js";
import { refreshGhosttyFont, useTerminalFont } from "./store.js";
import { TERMINAL_HOST_EXTENSION_ID, TERMINAL_PLACEMENT_SETTING, terminalPlacement, type TerminalPlacement } from "./protocol.js";

const PLACEMENTS: ReadonlyArray<{ value: TerminalPlacement; label: string }> = [
  { value: "dock", label: "Dock" },
  { value: "drawer", label: "Drawer" },
];

const SOURCE_LABEL: Record<TerminalFontSource, string> = {
  settings: "set here",
  ghostty: "from your Ghostty config",
  default: "platform default",
};

const SAMPLE = "┌─ ~/project ─┐  $ ls -la  0O 1lI {}[]";

/**
 * Terminal font and size. Empty fields follow the user's Ghostty config, and
 * without one the platform's monospace faces; the config is only ever read.
 */
export function TerminalSettingsPage({ preferences }: SettingsPageProps & { preferences: PreferencesStore }) {
  const { settings, ghostty, resolved } = useTerminalFont();
  useEffect(() => { void refreshGhosttyFont().catch(() => undefined); }, []);
  const set = (key: string, value: string) => preferences.setValue(TERMINAL_HOST_EXTENSION_ID, key, value);
  const ghosttyFace = ghostty?.families[0];
  useSyncExternalStore(preferences.subscribe, preferences.getSnapshot);
  const placement = terminalPlacement(preferences.value(TERMINAL_HOST_EXTENSION_ID, TERMINAL_PLACEMENT_SETTING));

  return <div className="settings-page terminal-settings">
    <h3>Terminal</h3>
    <div className="settings-label">Show the terminal in</div>
    <div className="segmented" role="group" aria-label="Show the terminal in">
      {PLACEMENTS.map((entry) => <button key={entry.value} type="button" className={entry.value === placement ? "active" : ""} aria-pressed={entry.value === placement} onClick={() => set(TERMINAL_PLACEMENT_SETTING, entry.value)}>{entry.label}</button>)}
    </div>
    <p className="settings-note">The dock is the panel on the right. The drawer sits below the conversation, full width, and keeps its height.</p>

    <p className="lede">The font the Terminal panel and terminal tabs draw with. Leave a field empty to follow your Ghostty config.</p>

    <div className="settings-label">Font family</div>
    <div className="terminal-settings-row">
      <input
        type="text"
        className="settings-search-input"
        aria-label="Terminal font family"
        placeholder={ghosttyFace ?? "SF Mono, Menlo (platform default)"}
        value={settings.family ?? ""}
        onChange={(event) => set(FONT_FAMILY_SETTING, event.target.value)}
      />
      {settings.family ? <button type="button" className="text-button" onClick={() => set(FONT_FAMILY_SETTING, "")}>Reset</button> : null}
    </div>

    <div className="settings-label">Font size</div>
    <div className="terminal-settings-row">
      <input
        type="number"
        min={6}
        max={32}
        step={0.5}
        className="settings-search-input terminal-settings-size"
        aria-label="Terminal font size"
        placeholder={String(ghostty?.size ?? resolved.size)}
        value={settings.size ?? ""}
        onChange={(event) => set(FONT_SIZE_SETTING, event.target.value)}
      />
      {settings.size ? <button type="button" className="text-button" onClick={() => set(FONT_SIZE_SETTING, "")}>Reset</button> : null}
    </div>

    <p className="settings-note" role="status">
      {resolved.face ?? "SF Mono"} ({SOURCE_LABEL[resolved.familySource]}) at {resolved.size}px ({SOURCE_LABEL[resolved.sizeSource]}).
    </p>
    <div className="terminal-settings-sample" style={{ fontFamily: resolved.family, fontSize: `${resolved.size}px` }}>{SAMPLE}</div>

    <div className="settings-label">Ghostty</div>
    <p className="settings-note">
      {ghostty === undefined
        ? "Reading the Ghostty config…"
        : ghostty.files.length === 0
          ? "No Ghostty config found."
          : <>Read from {ghostty.files.map((file, index) => <span key={file}>{index > 0 ? ", " : ""}<code>{file}</code></span>)}.</>}
    </p>
    {ghostty?.problems.map((problem) => <p key={problem} className="settings-note" data-level="error">{problem}</p>)}
  </div>;
}
