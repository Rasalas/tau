import type { UserTheme } from "../shared/contracts";
import type { PreferencesStore } from "./preferences";

/** The three answers to "which token set". `system` defers to `prefers-color-scheme`. */
export const BUILTIN_THEMES = ["system", "dark", "light"] as const;
export const THEME_PREFERENCES = BUILTIN_THEMES;

export type ThemePreference = (typeof BUILTIN_THEMES)[number] | string;

export const DEFAULT_THEME: ThemePreference = "system";

const userThemes = new Map<string, UserTheme>();

export function registerUserTheme(theme: UserTheme): void {
  userThemes.set(theme.id, theme);
}

export function registerUserThemes(themes: readonly UserTheme[]): void {
  userThemes.clear();
  for (const theme of themes) {
    userThemes.set(theme.id, theme);
  }
}

export function getUserTheme(id: string): UserTheme | undefined {
  return userThemes.get(id);
}

/** The themes the host found in the user's theme folders, as the last sync registered them. */
export function listUserThemes(): UserTheme[] {
  return Array.from(userThemes.values());
}

export function allAvailableThemes(): string[] {
  return [...BUILTIN_THEMES, ...Array.from(userThemes.keys())];
}

export function clearUserThemes(): void {
  userThemes.clear();
}

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === "string" && ((THEME_PREFERENCES as readonly string[]).includes(value) || userThemes.has(value));
}

export function nextTheme(theme: ThemePreference, available: readonly string[] = allAvailableThemes()): ThemePreference {
  const list = available.length > 0 ? available : THEME_PREFERENCES;
  const index = list.indexOf(theme);
  if (index === -1) return list[0] ?? DEFAULT_THEME;
  return list[(index + 1) % list.length];
}

/**
 * The whole of the mechanism: the preference goes on <html> as `data-theme`,
 * and `tokens.css` turns it into a `color-scheme`, which `light-dark()` reads.
 * When a user theme is active, its CSS is injected into <style id="user-theme">.
 */
export function applyTheme(
  theme: ThemePreference,
  root: HTMLElement = document.documentElement,
  targetDoc: Document = typeof document !== "undefined" ? document : (root.ownerDocument ?? document),
): void {
  root.dataset.theme = theme;
  if (!targetDoc || !targetDoc.head) return;
  let styleEl = targetDoc.getElementById("user-theme") as HTMLStyleElement | null;
  const userTheme = userThemes.get(theme);
  if (userTheme) {
    if (!styleEl) {
      styleEl = targetDoc.createElement("style");
      styleEl.id = "user-theme";
      targetDoc.head.append(styleEl);
    }
    styleEl.textContent = userTheme.css;
  } else if (styleEl) {
    styleEl.remove();
  }
}

/**
 * Applies typography overrides to the root element.
 */
export function applyAppearance(
  state: { fontFamily?: string; fontSize?: number },
  root: HTMLElement = document.documentElement,
): void {
  if (state.fontFamily) {
    root.style.setProperty("--font-family-override", state.fontFamily);
  } else {
    root.style.removeProperty("--font-family-override");
  }

  if (state.fontSize) {
    root.style.setProperty("--font-size-override", `${state.fontSize}px`);
  } else {
    root.style.removeProperty("--font-size-override");
  }
}

/**
 * Keeps <html> in step with the stored preference. Called before the first
 * render, so a window whose preference differs from the OS never paints the
 * other theme first.
 */
export function followThemePreference(preferences: PreferencesStore, root?: HTMLElement): () => void {
  const write = () => {
    const snapshot = preferences.getSnapshot();
    applyTheme(snapshot.theme, root);
    applyAppearance(snapshot, root);
  };
  write();
  return preferences.subscribe(write);
}
