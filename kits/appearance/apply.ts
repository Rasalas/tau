import type { PreferencesStore, UserTheme } from "tau";
import { APPEARANCE_EXTENSION_ID as ID, SETTING_KEYS } from "./protocol.js";
import { parseThemeCss, runtimeCss } from "./theme-css.js";

export const DENSITIES = ["compact", "normal", "comfortable"] as const;
export type Density = (typeof DENSITIES)[number];
export const TIMESTAMP_FORMATS = ["locale", "12h", "24h"] as const;
export type TimestampFormat = (typeof TIMESTAMP_FORMATS)[number];

export function readTimestamps(raw: unknown): TimestampFormat | undefined {
  return TIMESTAMP_FORMATS.includes(raw as TimestampFormat) ? raw as TimestampFormat : undefined;
}

export interface AppearanceValues {
  density: Density;
  contrast: number;
  themeLight: string;
  themeDark: string;
  promptFontFamily: string;
  promptFontSize?: number;
  codeFontFamily: string;
  codeFontSize?: number;
  /** Unset keeps core's 24-hour clock. */
  timestamps?: TimestampFormat;
  /** How long panels take to open and close; 0, the default, is at once. */
  panelMotion: number;
}

export const PANEL_MOTION_RANGE = { min: 0, max: 400, step: 25 } as const;

export function readPanelMotion(raw: unknown): number | undefined {
  const value = typeof raw === "string" && /^\d+$/u.test(raw) ? Number(raw) : undefined;
  return value !== undefined && value <= PANEL_MOTION_RANGE.max ? value : undefined;
}

export const FONT_SIZE_RANGE = { min: 10, max: 22 } as const;
/** What the code surfaces are drawn at when nothing is set; a chosen size scales them from here. */
export const DEFAULT_CODE_FONT_SIZE = 12;
export const DEFAULT_PROMPT_FONT_SIZE = 13;

export function readDensity(raw: unknown): Density | undefined {
  return DENSITIES.includes(raw as Density) ? raw as Density : undefined;
}

export function readSize(raw: unknown): number | undefined {
  const size = typeof raw === "string" && /^\d+$/u.test(raw) ? Number(raw) : undefined;
  return size !== undefined && size >= FONT_SIZE_RANGE.min && size <= FONT_SIZE_RANGE.max ? size : undefined;
}

export function readContrast(raw: unknown): number | undefined {
  const value = typeof raw === "string" && /^\d+$/u.test(raw) ? Number(raw) : undefined;
  return value !== undefined && value <= 100 ? value : undefined;
}

/** What applies to this window now: the preferences carry the project's own values over the host's. */
export function readAppearance(preferences: PreferencesStore): AppearanceValues {
  const value = (key: string) => preferences.value(ID, key);
  return {
    density: readDensity(value(SETTING_KEYS.density)) ?? "normal",
    contrast: readContrast(value(SETTING_KEYS.contrast)) ?? 0,
    themeLight: value(SETTING_KEYS.themeLight) ?? "",
    themeDark: value(SETTING_KEYS.themeDark) ?? "",
    promptFontFamily: value(SETTING_KEYS.promptFontFamily) ?? "",
    promptFontSize: readSize(value(SETTING_KEYS.promptFontSize)),
    codeFontFamily: value(SETTING_KEYS.codeFontFamily) ?? "",
    codeFontSize: readSize(value(SETTING_KEYS.codeFontSize)),
    timestamps: readTimestamps(value(SETTING_KEYS.timestamps)),
    panelMotion: readPanelMotion(value(SETTING_KEYS.panelMotion)) ?? 0,
  };
}

/** A font list typed by hand becomes one declaration; anything that could end it is dropped. */
export function cleanFontFamily(value: string): string {
  return value.replace(/[;{}<>]/gu, "").trim().slice(0, 200);
}

/**
 * Keeps <html> in step with the values: `data-density` (the kit's stylesheet
 * turns it into `--density`), the typography properties core reads, and one
 * stylesheet for the themes per scheme and the contrast. Everything goes when
 * the kit does.
 */
export class AppearanceApplier {
  private style?: HTMLStyleElement;

  constructor(private readonly doc: Document = document) {}

  apply(values: AppearanceValues, themes: readonly UserTheme[]): void {
    const root = this.doc.documentElement;
    if (values.density === "normal") delete root.dataset.density;
    else root.dataset.density = values.density;
    if (values.timestamps) root.dataset.timestamps = values.timestamps;
    else delete root.dataset.timestamps;
    const set = (name: string, value: string | undefined) => {
      if (value) root.style.setProperty(name, value);
      else root.style.removeProperty(name);
    };
    set("--prompt-font-family", cleanFontFamily(values.promptFontFamily) || undefined);
    set("--prompt-font-size", values.promptFontSize ? `${values.promptFontSize}px` : undefined);
    set("--code-font-family", cleanFontFamily(values.codeFontFamily) || undefined);
    set("--code-font-scale", values.codeFontSize ? String(values.codeFontSize / DEFAULT_CODE_FONT_SIZE) : undefined);
    set("--panel-motion", values.panelMotion > 0 ? `${values.panelMotion}ms` : undefined);

    const side = (id: string, scheme: "light" | "dark") => {
      const theme = id ? themes.find((entry) => entry.id === id) : undefined;
      return theme ? parseThemeCss(theme.css, theme.base)[scheme] : undefined;
    };
    const css = runtimeCss({ light: side(values.themeLight, "light"), dark: side(values.themeDark, "dark"), contrast: values.contrast });
    if (!css) { this.style?.remove(); this.style = undefined; return; }
    if (!this.style) {
      this.style = this.doc.createElement("style");
      this.style.id = "tau-appearance";
      this.doc.head.append(this.style);
    }
    this.style.textContent = css;
  }

  dispose(): void {
    const root = this.doc.documentElement;
    delete root.dataset.density;
    delete root.dataset.timestamps;
    for (const name of ["--prompt-font-family", "--prompt-font-size", "--code-font-family", "--code-font-scale", "--panel-motion"]) root.style.removeProperty(name);
    this.style?.remove();
    this.style = undefined;
  }
}
