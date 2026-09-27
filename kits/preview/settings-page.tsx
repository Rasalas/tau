import { SegmentedControl, Select, SettingRow, SettingsSection, Switch, useSetting, type SettingHandle } from "tau";
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

/** The page's rows, for the Settings search. */
export const PREVIEW_SETTINGS_ROWS = [
  { id: "setting-preview-viewport", label: "Viewport", keywords: ["size", "device", "mobile", "fill"] },
  { id: "setting-preview-zoom", label: "Zoom", keywords: ["scale", "percent"] },
  { id: "setting-preview-appearance", label: "Appearance", keywords: ["dark mode", "light", "prefers-color-scheme"] },
  { id: "setting-preview-links", label: "Open links from a thread in", keywords: ["browser", "links", "system browser"] },
  { id: "setting-preview-frame-rate", label: "Frame rate", keywords: ["recording", "fps", "video"] },
  { id: "setting-preview-clicks", label: "Show clicks", keywords: ["recording", "pointer", "ring"] },
  { id: "setting-preview-keys", label: "Show key presses", keywords: ["recording", "keys", "keystrokes"] },
  { id: "setting-preview-floating", label: "Float what an agent drives", keywords: ["floating", "picture in picture", "mini player"] },
];

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

  const toggle = (label: string, setting: SettingHandle<boolean>) => <Switch label={label} checked={setting.value} onChange={setting.set} />;

  return <div className="settings-page preview-settings">
    <h3>Preview</h3>
    <SettingsSection title="New pages">
      <SettingRow id="setting-preview-viewport" title="Viewport" description="A fixed size keeps its CSS width and is scaled down to fit the panel." setting={viewport}
        control={<Select label="Default viewport" width="lg" value={viewport.value} onChange={viewport.set}
          options={[{ value: "fill", label: "Fill the panel" }, ...VIEWPORT_PRESETS.map((preset) => ({ value: preset.id, label: `${preset.label} · ${preset.width}×${preset.height}` }))]} />} />
      <SettingRow id="setting-preview-zoom" title="Zoom" description="⌘+, ⌘− and ⌘0 zoom the page while it has the keyboard." setting={zoom}
        control={<Select label="Default zoom" width="sm" value={String(readZoom(zoom.value) ?? 1)} onChange={zoom.set}
          options={ZOOM_LEVELS.map((level) => ({ value: String(level), label: percent(level) }))} />} />
      <SettingRow id="setting-preview-appearance" title="Appearance" description="The prefers-color-scheme the page sees." setting={appearance}
        control={<SegmentedControl label="Default appearance" value={appearance.value} options={APPEARANCES} onChange={appearance.set} />} />
    </SettingsSection>
    <SettingsSection title="Links">
      <SettingRow id="setting-preview-links" title="Open links from a thread in" description="A web link in a reply opens here or in the system browser; ⌘-click always takes the browser." setting={linkTarget}
        control={<SegmentedControl label="Open links in" value={linkTarget.value} options={LINK_TARGETS} onChange={linkTarget.set} />} />
    </SettingsSection>
    <SettingsSection title="Recording">
      <SettingRow id="setting-preview-frame-rate" title="Frame rate" description="Frames per second the recording asks for." setting={frameRate}
        control={<SegmentedControl label="Frame rate" value={frameRate.value} options={FRAME_RATES.map((rate) => ({ value: String(rate), label: `${rate} fps` }))} onChange={frameRate.set} />} />
      <SettingRow id="setting-preview-clicks" title="Show clicks" description="A ring where the pointer presses." setting={clicks} control={toggle("Show clicks", clicks)} />
      <SettingRow id="setting-preview-keys" title="Show key presses" description="Keys and chords at the bottom of the page, never while a password field has focus." setting={keys} control={toggle("Show key presses", keys)} />
    </SettingsSection>
    <SettingsSection title="Floating preview">
      <SettingRow id="setting-preview-floating" title="Float what an agent drives" description="While the Preview panel is out of sight, a picture of the page or window an agent uses stays in a corner of the chat."
        help="It only shows; a click opens the Preview." setting={floating}
        control={toggle("Float what an agent drives", floating)} />
    </SettingsSection>
  </div>;
}
