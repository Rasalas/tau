/** Ids and command shapes both halves of the Appearance Kit share. */
export const APPEARANCE_EXTENSION_ID = "tau.appearance";
export const APPEARANCE_SETTINGS_PAGE = "appearance";

/** Its settings, as entries of Tau's `values` record: `values.tau.appearance.<key>`. */
export const SETTING_KEYS = {
  density: "density",
  contrast: "contrast",
  themeLight: "theme-light",
  themeDark: "theme-dark",
  promptFontFamily: "prompt-font-family",
  promptFontSize: "prompt-font-size",
  codeFontFamily: "code-font-family",
  codeFontSize: "code-font-size",
  timestamps: "timestamps",
  panelMotion: "panel-motion",
} as const;

export type Appearance = "light" | "dark";

/** `save-theme`: one scheme's tokens, written as a theme file in the user's themes folder. */
export interface SaveThemeInput {
  id: string;
  name: string;
  appearance: Appearance;
  tokens: Record<string, string>;
}

/** A refusal is an answer, not a failure: three failures in a row would stop the kit. */
export type SaveThemeResult = { id: string; path: string } | { error: string };

/**
 * Terminal Kit's font service (`kits/terminal/protocol.ts`), mirrored: a kit
 * never imports another kit, and the row is simply absent while the Terminal
 * Kit is off.
 */
export const TERMINAL_FONT_SERVICE = "tau.terminal/font";
export type TerminalFontSource = "settings" | "ghostty" | "default";
export interface TerminalFontServiceState {
  family: string;
  size: string;
  resolved: { face?: string; stack: string; size: number; familySource: TerminalFontSource; sizeSource: TerminalFontSource };
  ghostty?: { face?: string; size?: number; files: string[]; problems: string[] };
  sizeRange: { min: number; max: number };
}
export interface TerminalFontService {
  getSnapshot(): TerminalFontServiceState;
  subscribe(listener: () => void): () => void;
  set(change: { family?: string; size?: string }): void;
  refresh(): Promise<void>;
}
