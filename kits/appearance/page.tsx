import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Upload, Wand2 } from "lucide-react";
import { NumberField, SegmentedControl, SettingRow, SettingsSection, TextField, useSetting, userThemes, type PreferencesStore, type SettingHandle, type SettingsPageProps, type UserTheme } from "tau";
import { DENSITIES, DEFAULT_CODE_FONT_SIZE, DEFAULT_PROMPT_FONT_SIZE, FONT_SIZE_RANGE, PANEL_MOTION_RANGE, TIMESTAMP_FORMATS, cleanFontFamily, readContrast, readDensity, readPanelMotion, readSize, readTimestamps, type Density, type TimestampFormat } from "./apply.js";
import { draftFromWindow, type ThemeDraft, type ThemeEditorStore } from "./editor.js";
import { ModeTiles, PanelMotionPreview, ThemeCard, baseColors, themeColors, withoutOwnStyles, type Mode, type PreviewColors, type ThemeCardModel } from "./previews.js";
import { APPEARANCE_EXTENSION_ID as ID, SETTING_KEYS, type Appearance } from "./protocol.js";
import { parseThemeCss } from "./theme-css.js";
import { TerminalFontRow, type TerminalFontLink } from "./terminal-font.js";
import { importVsCodeTheme } from "./vscode-import.js";

const DENSITY_LABELS: Record<Density, string> = { compact: "Compact", normal: "Normal", comfortable: "Comfortable" };
const MODE_LABELS: Record<string, string> = { system: "System", light: "Light", dark: "Dark" };
const TIMESTAMP_LABELS: Record<TimestampFormat, string> = { locale: "Locale", "12h": "12-hour", "24h": "24-hour" };
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

/** A font family, written on blur or Enter; empty clears the level's value. */
function TextSetting({ label, placeholder, setting }: { label: string; placeholder: string; setting: SettingHandle<string> }) {
  return (
    <TextField label={label} placeholder={placeholder} width="md" value={setting.value} onCommit={(draft) => {
      const next = cleanFontFamily(draft);
      if (next === setting.value) return;
      if (next) setting.set(next);
      else setting.reset();
    }} />
  );
}

function SizeSetting({ label, setting, fallback }: { label: string; setting: SettingHandle<number | undefined>; fallback: number }) {
  return (
    <NumberField label={label} value={setting.value} min={FONT_SIZE_RANGE.min} max={FONT_SIZE_RANGE.max} integer unit="px" placeholder={String(fallback)}
      onCommit={setting.set} onClear={() => { if (setting.value !== undefined) setting.reset(); }} />
  );
}

/** What a user theme's card needs: its colours per scheme it has, and what the editor starts from. */
function themeCards(themes: readonly UserTheme[], base: Readonly<Record<Appearance, PreviewColors>>): Array<ThemeCardModel & { tokens: Partial<Record<Appearance, Record<string, string>>> }> {
  return themes.flatMap((theme) => {
    const tokens: Partial<Record<Appearance, Record<string, string>>> = {};
    const schemes: ThemeCardModel["schemes"] = {};
    const parsed = parseThemeCss(theme.css, theme.base);
    for (const scheme of ["light", "dark"] as const) {
      if (Object.keys(parsed[scheme]).length === 0) continue;
      tokens[scheme] = parsed[scheme];
      schemes[scheme] = themeColors(parsed[scheme], base[scheme]);
    }
    return Object.keys(schemes).length > 0 ? [{ id: theme.id, name: theme.name, schemes, tokens }] : [];
  });
}

/** A draft of a saved theme for one scheme, over what Tau paints, so every token has a value. */
function draftOf(card: { id: string; name: string; tokens: Partial<Record<Appearance, Record<string, string>>> }, scheme: Appearance): ThemeDraft {
  const tokens = card.tokens[scheme] ?? {};
  return {
    id: card.id, name: card.name, appearance: scheme,
    seed: { background: tokens["--shell"] ?? "#000000", foreground: tokens["--ink"] ?? "#ffffff", accent: tokens["--acid"] ?? "#888888" },
    tokens: { ...withoutOwnStyles(() => draftFromWindow(scheme)).tokens, ...Object.fromEntries(Object.entries(tokens).filter(([, token]) => token.startsWith("#"))) },
  };
}

/** Mode tiles and theme cards after T3 Code's: each tile paints with the themes it would use. */
function ColorsAndThemes({ themes, mode, scheme, preferences, onEdit, onImport, onNew }: {
  themes: readonly UserTheme[];
  preferences: PreferencesStore;
  mode: SettingHandle<string>;
  scheme: Appearance;
  onEdit(draft: ThemeDraft): void;
  onImport(): void;
  onNew(): void;
}) {
  const read = (raw: unknown) => (typeof raw === "string" ? raw : undefined);
  const halfOptions = (key: string) => ({ defaultValue: "", read, format: (id: string) => (id ? themes.find((theme) => theme.id === id)?.name ?? id : "Tau"), offline: (id: string) => preferences.setValue(ID, key, id) });
  const light = useSetting<string>(value(SETTING_KEYS.themeLight), halfOptions(SETTING_KEYS.themeLight));
  const dark = useSetting<string>(value(SETTING_KEYS.themeDark), halfOptions(SETTING_KEYS.themeDark));
  const halves: Record<Appearance, SettingHandle<string>> = { light, dark };
  const base = { light: baseColors("light"), dark: baseColors("dark") };
  const cards = themeCards(themes, base);
  const owner = (half: Appearance) => cards.find((card) => card.id === halves[half].value && card.schemes[half]);
  const shown = { light: owner("light")?.schemes.light ?? base.light, dark: owner("dark")?.schemes.dark ?? base.dark };
  const activeFor = (id: string) => (["light", "dark"] as const).filter((half) => (owner(half)?.id ?? "") === id);
  const use = (id: string, schemes: readonly Appearance[]) => {
    for (const half of schemes) {
      if (id) halves[half].set(id);
      else if (halves[half].origin !== "default") halves[half].reset();
    }
  };
  // A theme chosen as the preference itself (core's older way) stays reachable as a tile of its own.
  const legacy = MODE_LABELS[mode.value] ? undefined : themes.find((theme) => theme.id === mode.value);
  return <>
    <SettingRow
      id="setting-appearance-mode"
      title="Mode"
      description="System follows this machine's light or dark setting."
      setting={mode}
      control={legacy ? <button type="button" className="chrome-button" aria-pressed onClick={() => mode.set("system")}>{legacy.name} · use System</button> : undefined}
    >
      <ModeTiles value={mode.value} colors={shown} onChange={(next: Mode) => mode.set(next)} />
    </SettingRow>
    <SettingRow
      id="setting-appearance-themes"
      title="Themes"
      description="A swatch gives a theme that scheme; its name gives it every scheme it has. Your themes are the files in the themes folder."
      control={<>
        <button type="button" className="chrome-button" onClick={onNew}><Wand2 size={13} /> New theme</button>
        <button type="button" className="chrome-button" onClick={onImport}><Upload size={13} /> Import VS Code theme</button>
      </>}
    >
      <div className="appearance-theme-grid">
        <ThemeCard theme={{ id: "", name: "Tau", schemes: base }} active={activeFor("")} onUse={(schemes) => use("", schemes)} editLabel="Customize" onEdit={() => onEdit(withoutOwnStyles(() => draftFromWindow(scheme, scheme === "light" ? "My light theme" : "My dark theme")))} />
        {cards.map((card) => (
          <ThemeCard key={card.id} theme={card} active={activeFor(card.id)} onUse={(schemes) => use(card.id, schemes)} editLabel="Edit" onEdit={() => onEdit(draftOf(card, card.schemes[scheme] ? scheme : card.schemes.light ? "light" : "dark"))} />
        ))}
      </div>
    </SettingRow>
  </>;
}

/** Settings → Appearance: themes per scheme, the editor and the importer, contrast, density and type. */
export function AppearancePage({ onNotify, preferences, editor, terminalFont }: SettingsPageProps & { preferences: PreferencesStore; editor: ThemeEditorStore; terminalFont?: TerminalFontLink }) {
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

  const timestamps = useSetting<TimestampFormat>(value(SETTING_KEYS.timestamps), { defaultValue: "24h", read: readTimestamps, format: (next) => TIMESTAMP_LABELS[next] });
  const [contrastDraft, setContrastDraft] = useState(contrast.value);
  useEffect(() => setContrastDraft(contrast.value), [contrast.value]);
  const panelMotion = useSetting<number>(value(SETTING_KEYS.panelMotion), { defaultValue: 0, read: readPanelMotion, write: String, format: (next) => `${next} ms`, offline: (next) => preferences.setValue(ID, SETTING_KEYS.panelMotion, String(next)) });
  const [motionDraft, setMotionDraft] = useState(panelMotion.value);
  useEffect(() => setMotionDraft(panelMotion.value), [panelMotion.value]);
  const commitMotion = () => { if (motionDraft !== panelMotion.value) panelMotion.set(motionDraft); };

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
        <ColorsAndThemes themes={themes} mode={mode} scheme={scheme} preferences={preferences} onEdit={(draft) => editor.open(draft)} onNew={() => editor.open(draftFromWindow(scheme))} onImport={() => fileRef.current?.click()} />
        <input ref={fileRef} type="file" hidden accept=".json,.jsonc,application/json" aria-label="VS Code theme file" onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void importFile(file);
        }} />
      </SettingsSection>

      <SettingsSection title="Interface">
        <SettingRow
          id="setting-appearance-density"
          title="Density"
          description="How much room rows, lists and panels take. A project can have its own."
          setting={density}
          control={<SegmentedControl label="Density" value={density.value} options={DENSITIES.map((next) => ({ value: next, label: DENSITY_LABELS[next] }))} onChange={density.set} />}
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
        <SettingRow
          id="setting-appearance-timestamps"
          title="Timestamps"
          description="The clock message and tool times are written in; Locale follows this machine's region. Rows already on screen change when they are drawn again."
          setting={timestamps}
          control={<SegmentedControl label="Timestamps" value={timestamps.value} options={TIMESTAMP_FORMATS.map((next) => ({ value: next, label: TIMESTAMP_LABELS[next] }))} onChange={timestamps.set} />}
        />
      </SettingsSection>

      <SettingsSection title="Motion">
        <SettingRow
          id="setting-appearance-panel-animations"
          title="Panel animations"
          description="How long the sidebar, the dock and the drawer take to open and close. At 0 they do so at once; a system setting for reduced motion always wins."
          setting={panelMotion}
          control={<span className="appearance-motion">
            <PanelMotionPreview ms={motionDraft} />
            <span className="appearance-slider">
              <output htmlFor="appearance-panel-motion">{motionDraft} ms</output>
              <input id="appearance-panel-motion" type="range" aria-label="Panel animation duration" min={PANEL_MOTION_RANGE.min} max={PANEL_MOTION_RANGE.max} step={PANEL_MOTION_RANGE.step} value={motionDraft}
                onChange={(event) => setMotionDraft(Number(event.target.value))} onPointerUp={commitMotion} onKeyUp={commitMotion} />
            </span>
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
          description="Code blocks, tool output, diffs and file previews. The terminal has its own row."
          setting={codeFamily}
          control={<><TextSetting label="Code font family" placeholder="System monospace" setting={codeFamily} /><SizeSetting label="Code font size" setting={codeSize} fallback={DEFAULT_CODE_FONT_SIZE} /></>}
        />
        {terminalFont ? <TerminalFontRow link={terminalFont} /> : null}
      </SettingsSection>
    </div>
  );
}
