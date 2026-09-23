import { useSyncExternalStore, type ReactNode } from "react";
import type { PreferencesStore, SettingsPageProps } from "tau";
import { PREVIEW_HOST_EXTENSION_ID as ID, type PreviewAppearance } from "./protocol.js";
import { PREVIEW_SETTINGS as KEYS, defaultsFromPreferences, floatingEnabled, readLinkTarget, type LinkTarget } from "./settings.js";
import { FRAME_RATES, VIEWPORT_PRESETS, ZOOM_LEVELS } from "./viewport.js";

const APPEARANCES: ReadonlyArray<{ value: PreviewAppearance; label: string }> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

const LINK_TARGETS: ReadonlyArray<{ value: LinkTarget; label: string }> = [
  { value: "system", label: "System browser" },
  { value: "app", label: "Preview" },
];

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <div className="settings-field-row">
    <span className="settings-field-label"><strong>{label}</strong>{hint ? <small>{hint}</small> : null}</span>
    {children}
  </div>;
}

function Segmented<T extends string | number>({ label, value, choices, onChange }: {
  label: string;
  value: T;
  choices: ReadonlyArray<{ value: T; label: string }>;
  onChange(value: T): void;
}) {
  return <div className="segmented" role="group" aria-label={label}>
    {choices.map((choice) => <button
      key={String(choice.value)}
      type="button"
      className={choice.value === value ? "active" : ""}
      aria-pressed={choice.value === value}
      onClick={() => onChange(choice.value)}
    >{choice.label}</button>)}
  </div>;
}

function Switch({ label, on, onChange }: { label: string; on: boolean; onChange(on: boolean): void }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} className={`switch ${on ? "on" : ""}`} onClick={() => onChange(!on)}><i /></button>;
}

/**
 * Settings → Preview, after T3 Code's Browser settings: what a page opens
 * with, where links from a thread go, what a recording shows, and the
 * floating preview.
 */
export function PreviewSettingsPage({ preferences }: SettingsPageProps & { preferences: PreferencesStore }) {
  useSyncExternalStore(preferences.subscribe, preferences.getSnapshot);
  const defaults = defaultsFromPreferences(preferences);
  const set = (key: string, value: string) => preferences.setValue(ID, key, value);
  const viewport = defaults.viewport.mode === "fill" ? "fill" : defaults.viewport.preset ?? `${defaults.viewport.width}x${defaults.viewport.height}`;
  const linkTarget = readLinkTarget(preferences.value(ID, KEYS.linkTarget));

  return <div className="settings-page preview-settings">
    <h3>Preview</h3>
    <p className="lede">What a page in the Preview opens with. The agent and the panel's own menu can change a page afterwards; these apply to the next one.</p>

    <div className="settings-label">New pages</div>
    <Row label="Viewport" hint="A fixed size keeps its CSS width and is scaled down to fit the panel">
      <select className="settings-select" aria-label="Default viewport" value={viewport} onChange={(event) => set(KEYS.viewport, event.target.value)}>
        <option value="fill">Fill the panel</option>
        {VIEWPORT_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.label} · {preset.width}×{preset.height}</option>)}
      </select>
    </Row>
    <Row label="Zoom" hint="⌘+, ⌘− and ⌘0 zoom the page while it has the keyboard">
      <select className="settings-select" aria-label="Default zoom" value={String(defaults.zoom)} onChange={(event) => set(KEYS.zoom, event.target.value)}>
        {ZOOM_LEVELS.map((level) => <option key={level} value={String(level)}>{Math.round(level * 100)}%</option>)}
      </select>
    </Row>
    <Row label="Appearance" hint="The prefers-color-scheme the page sees">
      <Segmented label="Default appearance" value={defaults.appearance} choices={APPEARANCES} onChange={(value) => set(KEYS.appearance, value)} />
    </Row>

    <div className="settings-label">Links</div>
    <Row label="Open links from a thread in" hint="⌘-click always opens the system browser">
      <Segmented label="Open links in" value={linkTarget} choices={LINK_TARGETS} onChange={(value) => set(KEYS.linkTarget, value)} />
    </Row>

    <div className="settings-label">Recording</div>
    <Row label="Frame rate" hint="Frames per second the recording asks for">
      <Segmented label="Frame rate" value={defaults.recording.frameRate} choices={FRAME_RATES.map((rate) => ({ value: rate, label: `${rate} fps` }))} onChange={(value) => set(KEYS.frameRate, String(value))} />
    </Row>
    <Row label="Show clicks" hint="A ring where the pointer presses">
      <Switch label="Show clicks" on={defaults.recording.showClicks} onChange={(on) => preferences.setOption(ID, KEYS.showClicks, on)} />
    </Row>
    <Row label="Show key presses" hint="Keys and chords at the bottom of the page, never inside a password field">
      <Switch label="Show key presses" on={defaults.recording.showKeys} onChange={(on) => preferences.setOption(ID, KEYS.showKeys, on)} />
    </Row>

    <div className="settings-label">Floating preview</div>
    <Row label="Float what the agent drives" hint="While the Preview panel is hidden, a small picture of the page or window the agent uses stays in a corner">
      <Switch label="Float what the agent drives" on={floatingEnabled(preferences)} onChange={(on) => preferences.setOption(ID, KEYS.floating, on)} />
    </Row>
  </div>;
}
