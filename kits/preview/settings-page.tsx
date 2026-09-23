import { SettingRow, SettingsSection, useSetting, type SettingHandle } from "tau";
import { PREVIEW_HOST_EXTENSION_ID as ID } from "./protocol.js";
import { PREVIEW_SETTINGS as KEYS } from "./settings.js";
import { FRAME_RATES, VIEWPORT_PRESETS, ZOOM_LEVELS, readAppearance, readFrameRate, readViewport, readZoom, viewportLabel } from "./viewport.js";

const value = (key: string) => `values.${ID}.${key}`;
const option = (key: string) => `options.${ID}.${key}`;
const readBoolean = (raw: unknown) => (typeof raw === "boolean" ? raw : undefined);
const readString = (raw: unknown) => (typeof raw === "string" ? raw : undefined);

const APPEARANCES = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
] as const;

const LINK_TARGETS = [
  { value: "system", label: "Browser" },
  { value: "app", label: "Preview" },
] as const;

const percent = (factor: number) => `${Math.round(factor * 100)}%`;

function Toggle({ label, setting }: { label: string; setting: SettingHandle<boolean> }) {
  return <button type="button" className={`switch ${setting.value ? "on" : ""}`} role="switch" aria-checked={setting.value} aria-label={label} disabled={!setting.writable} onClick={() => setting.set(!setting.value)}><i /></button>;
}

function Choice({ label, setting, choices }: { label: string; setting: SettingHandle<string>; choices: ReadonlyArray<{ value: string; label: string }> }) {
  return <div className="segmented" role="group" aria-label={label}>
    {choices.map((choice) => <button
      key={choice.value}
      type="button"
      disabled={!setting.writable}
      className={setting.value === choice.value ? "active" : ""}
      aria-pressed={setting.value === choice.value}
      onClick={() => setting.set(choice.value)}
    >{choice.label}</button>)}
  </div>;
}

/**
 * Settings → Preview, after T3 Code's Browser settings: what a page opens
 * with, where links from a thread go, what a recording shows, and the
 * floating preview. Every row takes a project override.
 */
export function PreviewSettingsPage() {
  const viewport = useSetting<string>(value(KEYS.viewport), {
    defaultValue: "fill",
    scope: "both",
    read: (raw) => (readViewport(raw) ? String(raw) : undefined),
    format: (next) => viewportLabel(readViewport(next) ?? { mode: "fill" }),
  });
  const zoom = useSetting<string>(value(KEYS.zoom), { defaultValue: "1", scope: "both", read: (raw) => (readZoom(raw) === undefined ? undefined : String(raw)), format: (next) => percent(Number(next)) });
  const appearance = useSetting<string>(value(KEYS.appearance), { defaultValue: "system", scope: "both", read: (raw) => readAppearance(raw), format: (next) => APPEARANCES.find((entry) => entry.value === next)?.label ?? next });
  const linkTarget = useSetting<string>(value(KEYS.linkTarget), { defaultValue: "system", read: readString, format: (next) => (next === "app" ? "Preview" : "Browser") });
  const frameRate = useSetting<string>(value(KEYS.frameRate), { defaultValue: "30", read: (raw) => (readFrameRate(raw) ? String(raw) : undefined), format: (next) => `${next} fps` });
  const clicks = useSetting<boolean>(option(KEYS.showClicks), { defaultValue: false, scope: "both", read: readBoolean });
  const keys = useSetting<boolean>(option(KEYS.showKeys), { defaultValue: false, scope: "both", read: readBoolean });
  const floating = useSetting<boolean>(option(KEYS.floating), { defaultValue: true, read: readBoolean });

  return <div className="settings-page preview-settings">
    <h3>Preview</h3>
    <SettingsSection title="New pages">
      <SettingRow id="setting-preview-viewport" title="Viewport" description="A fixed size keeps its CSS width and is scaled down to fit the panel." setting={viewport}
        control={<select className="settings-select" aria-label="Default viewport" disabled={!viewport.writable} value={viewport.value} onChange={(event) => viewport.set(event.target.value)}>
          <option value="fill">Fill the panel</option>
          {VIEWPORT_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.label} · {preset.width}×{preset.height}</option>)}
        </select>} />
      <SettingRow id="setting-preview-zoom" title="Zoom" description="⌘+, ⌘− and ⌘0 zoom the page while it has the keyboard." setting={zoom}
        control={<select className="settings-select" aria-label="Default zoom" disabled={!zoom.writable} value={String(readZoom(zoom.value) ?? 1)} onChange={(event) => zoom.set(event.target.value)}>
          {ZOOM_LEVELS.map((level) => <option key={level} value={String(level)}>{percent(level)}</option>)}
        </select>} />
      <SettingRow id="setting-preview-appearance" title="Appearance" description="The prefers-color-scheme the page sees." setting={appearance}
        control={<Choice label="Default appearance" setting={appearance} choices={APPEARANCES} />} />
    </SettingsSection>
    <SettingsSection title="Links">
      <SettingRow id="setting-preview-links" title="Open links from a thread in" description="A web link in a reply opens here or in the system browser; ⌘-click always takes the browser." setting={linkTarget}
        control={<Choice label="Open links in" setting={linkTarget} choices={LINK_TARGETS} />} />
    </SettingsSection>
    <SettingsSection title="Recording">
      <SettingRow id="setting-preview-frame-rate" title="Frame rate" description="Frames per second the recording asks for." setting={frameRate}
        control={<Choice label="Frame rate" setting={frameRate} choices={FRAME_RATES.map((rate) => ({ value: String(rate), label: String(rate) }))} />} />
      <SettingRow id="setting-preview-clicks" title="Show clicks" description="A ring where the pointer presses." setting={clicks} control={<Toggle label="Show clicks" setting={clicks} />} />
      <SettingRow id="setting-preview-keys" title="Show key presses" description="Keys and chords at the bottom of the page, never while a password field has focus." setting={keys} control={<Toggle label="Show key presses" setting={keys} />} />
    </SettingsSection>
    <SettingsSection title="Floating preview">
      <SettingRow id="setting-preview-floating" title="Float what an agent drives" description="While the Preview panel is out of sight, a picture of the page or window an agent uses stays in a corner of the chat. It only shows; a click opens the Preview." setting={floating}
        control={<Toggle label="Float what an agent drives" setting={floating} />} />
    </SettingsSection>
  </div>;
}
