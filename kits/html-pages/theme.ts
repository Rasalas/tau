import { PAGE_THEME_TOKENS } from "./protocol.js";

/**
 * The workbench's tokens as the variables a page reads. A token's value is
 * returned as declared (`light-dark(…)` included), so the page follows the
 * colour scheme the frame sets without another message.
 */
export function pageTheme(root: HTMLElement = document.documentElement): Record<string, string> {
  const style = getComputedStyle(root);
  const theme: Record<string, string> = {};
  for (const [name, token] of Object.entries(PAGE_THEME_TOKENS)) {
    const value = style.getPropertyValue(token).trim();
    if (value) theme[name] = value;
  }
  return theme;
}
