import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Upload, Wand2 } from "lucide-react";
import { SettingRow, SettingsSection, useSetting, userThemes, type PreferencesStore, type SettingHandle, type SettingsPageProps, type UserTheme } from "tau";
import { DENSITIES, DEFAULT_CODE_FONT_SIZE, DEFAULT_PROMPT_FONT_SIZE, FONT_SIZE_RANGE, cleanFontFamily, readContrast, readDensity, readSize, type Density } from "./apply.js";
import { currentToken, draftFromWindow, type ThemeDraft, type ThemeEditorStore } from "./editor.js";
import { APPEARANCE_EXTENSION_ID as ID, SETTING_KEYS, type Appearance } from "./protocol.js";
import { parseThemeCss } from "./theme-css.js";
import { importVsCodeTheme } from "./vscode-import.js";

const DENSITY_LABELS: Record<Density, string> = { compact: "Compact", normal: "Normal", comfortable: "Comfortable" };
const MODE_LABELS: Record<string, string> = { system: "System", light: "Light", dark: "Dark" };
const value = (key: string) => `values.${ID}.${key}`;
const readString = (raw: unknown) => (typeof raw === "string" ? raw : undefined);

/** A dropped or chosen file as text; FileReader where `Blob.text` is missing. */
function readText(file: File): Promise<string> {
  if (typeof file.text === "function") return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the file."));
    reader.readAsText(file);
  });
}

/** The themes that carry colours for a scheme, with the three that show what they look like. */
function themesFor(themes: readonly UserTheme[], scheme: Appearance) {
  return themes.flatMap((theme) => {
    const tokens = parseThemeCss(theme.css, theme.base)[scheme];
    return Object.keys(tokens).length > 0 ? [{ theme, tokens }] : [];
  });
}

function Swatches({ colors }: { colors: ReadonlyArray<string | undefined> }) {
  return (
    <span className="appearance-swatches" aria-hidden>
      {colors.map((color, index) => <i key={index} style={color ? { background: color } : undefined} />)}
    </span>
  );
}

/** A text field committed on blur or Enter; empty clears the level's value. */
function TextSetting({ label, placeholder, setting }: { label: string; placeholder: string; setting: SettingHandle<string> }) {
  const [draft, setDraft] = useState(setting.value);
  useEffect(() => setDraft(setting.value), [setting.value]);
  const commit = () => {
    const next = cleanFontFamily(draft);
    if (next === setting.value) return;
    if (next) setting.set(next);
    else setting.reset();
  };
  return <input type="text" className="settings-input" aria-label={label} placeholder={placeholder} value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") commit(); }} />;
}

function SizeSetting({ label, setting, fallback }: { label: string; setting: SettingHandle<number | undefined>; fallback: number }) {
  const [draft, setDraft] = useState(setting.value !== undefined ? String(setting.value) : "");
  useEffect(() => setDraft(setting.value !== undefined ? String(setting.value) : ""), [setting.value]);
  const commit = () => {
    if (!draft.trim()) { if (setting.value !== undefined) setting.reset(); return; }
    const size = Number(draft);
    if (Number.isInteger(size) && size >= FONT_SIZE_RANGE.min && size <= FONT_SIZE_RANGE.max) { if (size !== setting.value) setting.set(size); }
    else setDraft(setting.value !== undefined ? String(setting.value) : "");
  };
  return (
    <span className="appearance-size">
      <input type="number" className="settings-input narrow" aria-label={label} min={FONT_SIZE_RANGE.min} max={FONT_SIZE_RANGE.max} placeholder={String(fallback)} value={draft}
        onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") commit(); }} />
      <small>px</small>
    </span>
  );
}

function ThemeHalfRow({ scheme, themes, onEdit }: { scheme: Appearance; themes: readonly UserTheme[]; onEdit(draft: ThemeDraft): void }) {
  const setting = useSetting<string>(value(scheme === "light" ? SETTING_KEYS.themeLight : SETTING_KEYS.themeDark), {
    defaultValue: "", read: readString, format: (id) => (id ? themes.find((theme) => theme.id === id)?.name ?? id : "Tau"),
  });
  const choices = themesFor(themes, scheme);
  const chosen = choices.find((entry) => entry.theme.id === setting.value);
  const colors = chosen
    ? [chosen.tokens["--shell"] ?? chosen.tokens["--stage"], chosen.tokens["--ink"], chosen.tokens["--acid"]]
    : [currentToken("--shell", scheme), currentToken("--ink", scheme), currentToken("--acid", scheme)];
  const edit = () => onEdit(chosen
    ? { id: chosen.theme.id, name: chosen.theme.name, appearance: scheme, seed: { background: chosen.tokens["--shell"] ?? "#000000", foreground: chosen.tokens["--ink"] ?? "#ffffff", accent: chosen.tokens["--acid"] ?? "#888888" }, tokens: { ...draftFromWindow(scheme).tokens, ...Object.fromEntries(Object.entries(chosen.tokens).filter(([, token]) => token.startsWith("#"))) } }
    : draftFromWindow(scheme, scheme === "light" ? "My light theme" : "My dark theme"));
  return (
    <SettingRow
      id={`setting-appearance-theme-${scheme}`}
      title={scheme === "light" ? "Light theme" : "Dark theme"}
      description={`What the window paints with in the ${scheme} scheme${scheme === "light" ? ", with System in a light OS" : ", with System in a dark OS"}.`}
      setting={setting}
      control={<>
        <Swatches colors={colors} />
        <select className="settings-select" aria-label={scheme === "light" ? "Light theme" : "Dark theme"} value={chosen ? setting.value : ""} onChange={(event) => (event.target.value ? setting.set(event.target.value) : setting.reset())}>
          <option value="">Tau</option>
          {choices.map(({ theme }) => <option key={theme.id} value={theme.id}>{theme.name}</option>)}
        </select>
        <button type="button" className="chrome-button" onClick={edit}>{chosen ? "Edit" : "Customize"}</button>
      </>}
    />
  );
}

/** Settings → Appearance: themes per scheme, the editor and the importer, contrast, density and type. */
export function AppearancePage({ onNotify, preferences, editor }: SettingsPageProps & { preferences: PreferencesStore; editor: ThemeEditorStore }) {
  // A sync registers the user's themes and emits, so this page follows new ones.
  useSyncExternalStore(preferences.subscribe, preferences.getSnapshot);
  const themes = userThemes();
  const fileRef = useRef<HTMLInputElement>(null);

  const mode = useSetting<string>("theme", { defaultValue: "system", read: readString, format: (id) => MODE_LABELS[id] ?? themes.find((theme) => theme.id === id)?.name ?? id, offline: (next) => preferences.setTheme(next) });
  const density = useSetting<Density>(value(SETTING_KEYS.density), { defaultValue: "normal", scope: "both", read: readDensity, format: (next) => DENSITY_LABELS[next] });
  const contrast = useSetting<number>(value(SETTING_KEYS.contrast), { defaultValue: 0, read: readContrast, write: String, format: (next) => `${next}%` });
  const interfaceFamily = useSetting<string>("fontFamily", { defaultValue: "", read: readString, format: (next) => next || "System", offline: (next) => preferences.setFontFamily(next || undefined) });
  const interfaceSize = useSetting<number | undefined>("fontSize", { defaultValue: undefined, read: (raw) => (typeof raw === "number" ? raw : undefined), format: (next) => (next ? `${next}px` : "13px"), offline: (next) => preferences.setFontSize(next) });
  const promptFamily = useSetting<string>(value(SETTING_KEYS.promptFontFamily), { defaultValue: "", read: readString, format: (next) => next || "Interface font" });
  const promptSize = useSetting<number | undefined>(value(SETTING_KEYS.promptFontSize), { defaultValue: undefined, read: readSize, write: String, format: (next) => (next ? `${next}px` : `${DEFAULT_PROMPT_FONT_SIZE}px`) });
  const codeFamily = useSetting<string>(value(SETTING_KEYS.codeFontFamily), { defaultValue: "", read: readString, format: (next) => next || "System monospace" });
  const codeSize = useSetting<number | undefined>(value(SETTING_KEYS.codeFontSize), { defaultValue: undefined, read: readSize, write: String, format: (next) => (next ? `${next}px` : `${DEFAULT_CODE_FONT_SIZE}px`) });

  const modes = ["system", "light", "dark", ...(MODE_LABELS[mode.value] ? [] : [mode.value])];
  const [contrastDraft, setContrastDraft] = useState(contrast.value);
  useEffect(() => setContrastDraft(contrast.value), [contrast.value]);

  const importFile = async (file: File) => {
    try {
      const imported = importVsCodeTheme(await readText(file));
      editor.open({ name: imported.name, appearance: imported.appearance, seed: imported.seed, tokens: imported.tokens });
    } catch (error) {
      onNotify(`${file.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const scheme: Appearance = document.documentElement.dataset.theme === "light" || (document.documentElement.dataset.theme !== "dark" && globalThis.matchMedia?.("(prefers-color-scheme: light)").matches) ? "light" : "dark";

  return (
    <div className="settings-page appearance-page">
      <h3>Appearance</h3>
      <SettingsSection title="Colors & themes">
        <SettingRow
          id="setting-appearance-mode"
          title="Mode"
          description="System follows this machine's light or dark setting; the two themes below say what each looks like."
          setting={mode}
          control={<div className="segmented" role="group" aria-label="Mode">
            {modes.map((id) => (
              <button key={id} type="button" className={mode.value === id ? "active" : ""} aria-pressed={mode.value === id} onClick={() => mode.set(id)}>
                {MODE_LABELS[id] ?? themes.find((theme) => theme.id === id)?.name ?? id}
              </button>
            ))}
          </div>}
        />
        <ThemeHalfRow scheme="light" themes={themes} onEdit={(draft) => editor.open(draft)} />
        <ThemeHalfRow scheme="dark" themes={themes} onEdit={(draft) => editor.open(draft)} />
        <SettingRow
          id="setting-appearance-editor"
          title="Theme editor"
          description="Make a theme from three colours or token by token; the draft paints the window while you work, and Save writes it to your themes folder."
          control={<>
            <button type="button" className="chrome-button" onClick={() => editor.open(draftFromWindow(scheme))}><Wand2 size={13} /> New theme</button>
            <button type="button" className="chrome-button" onClick={() => fileRef.current?.click()}><Upload size={13} /> Import VS Code theme</button>
            <input ref={fileRef} type="file" hidden accept=".json,.jsonc,application/json" aria-label="VS Code theme file" onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void importFile(file);
            }} />
          </>}
        />
      </SettingsSection>

      <SettingsSection title="Interface">
        <SettingRow
          id="setting-appearance-density"
          title="Density"
          description="How much room rows, lists and panels take. A project can have its own."
          setting={density}
          control={<div className="segmented" role="group" aria-label="Density">
            {DENSITIES.map((next) => (
              <button key={next} type="button" className={density.value === next ? "active" : ""} aria-pressed={density.value === next} onClick={() => density.set(next)}>{DENSITY_LABELS[next]}</button>
            ))}
          </div>}
        />
        <SettingRow
          id="setting-appearance-contrast"
          title="Contrast"
          description="Draws hairlines and quiet text closer to the ink."
          setting={contrast}
          control={<span className="appearance-slider">
            <output htmlFor="appearance-contrast">{contrastDraft}%</output>
            <input id="appearance-contrast" type="range" aria-label="Contrast" min={0} max={100} step={5} value={contrastDraft}
              onChange={(event) => setContrastDraft(Number(event.target.value))}
              onPointerUp={() => { if (contrastDraft !== contrast.value) contrast.set(contrastDraft); }}
              onKeyUp={() => { if (contrastDraft !== contrast.value) contrast.set(contrastDraft); }} />
          </span>}
        />
      </SettingsSection>

      <SettingsSection title="Typography">
        <SettingRow
          id="setting-appearance-interface-font"
          title="Interface font"
          description="Everything outside code and the terminal."
          setting={interfaceFamily}
          control={<><TextSetting label="Interface font family" placeholder="System" setting={interfaceFamily} /><SizeSetting label="Interface font size" setting={interfaceSize} fallback={13} /></>}
        />
        <SettingRow
          id="setting-appearance-prompt-font"
          title="Prompt font"
          description="Only the box you write prompts in. A monospace face works well here."
          setting={promptFamily}
          control={<><TextSetting label="Prompt font family" placeholder="Interface font" setting={promptFamily} /><SizeSetting label="Prompt font size" setting={promptSize} fallback={DEFAULT_PROMPT_FONT_SIZE} /></>}
        />
        <SettingRow
          id="setting-appearance-code-font"
          title="Code font"
          description="Code blocks, tool output, diffs and file previews. The terminal keeps the font on its own page."
          setting={codeFamily}
          control={<><TextSetting label="Code font family" placeholder="System monospace" setting={codeFamily} /><SizeSetting label="Code font size" setting={codeSize} fallback={DEFAULT_CODE_FONT_SIZE} /></>}
        />
      </SettingsSection>
    </div>
  );
}
