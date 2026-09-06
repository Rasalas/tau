import type { PreferencesStore } from "./preferences";

/** The three answers to "which token set". `system` defers to `prefers-color-scheme`. */
export const THEME_PREFERENCES = ["system", "dark", "light"] as const;

export type ThemePreference = typeof THEME_PREFERENCES[number];

export const DEFAULT_THEME: ThemePreference = "system";

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === "string" && (THEME_PREFERENCES as readonly string[]).includes(value);
}

export function nextTheme(theme: ThemePreference): ThemePreference {
  return THEME_PREFERENCES[(THEME_PREFERENCES.indexOf(theme) + 1) % THEME_PREFERENCES.length];
}

/**
 * The whole of the mechanism: the preference goes on <html> as `data-theme`,
 * and `tokens.css` turns it into a `color-scheme`, which `light-dark()` reads.
 * Nothing else in the client knows a colour.
 */
export function applyTheme(theme: ThemePreference, root: HTMLElement = document.documentElement): void {
  root.dataset.theme = theme;
}

/**
 * Keeps <html> in step with the stored preference. Called before the first
 * render, so a window whose preference differs from the OS never paints the
 * other theme first.
 */
export function followThemePreference(preferences: PreferencesStore, root?: HTMLElement): () => void {
  const write = () => { applyTheme(preferences.getSnapshot().theme, root); };
  write();
  return preferences.subscribe(write);
}
