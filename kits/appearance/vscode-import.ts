import { contrast, flatten, isDark, parseHex, readable, type Rgba } from "./color.js";
import { derivePalette } from "./palette.js";
import type { Appearance } from "./protocol.js";

export interface ImportedTheme {
  name: string;
  appearance: Appearance;
  tokens: Record<string, string>;
  /** The three colours the palette was derived from, for the editor's basic fields. */
  seed: { background: string; foreground: string; accent: string };
}

/** VS Code writes its theme files as JSONC: comments and trailing commas are allowed. */
export function parseJsonc(text: string): unknown {
  let out = "";
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    const next = text[index + 1];
    if (inString) {
      out += char;
      if (char === "\\") { out += next ?? ""; index += 1; } else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") { inString = true; out += char; continue; }
    if (char === "/" && next === "/") { while (index < text.length && text[index] !== "\n") index += 1; out += "\n"; continue; }
    if (char === "/" && next === "*") { index += 2; while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) index += 1; index += 1; continue; }
    out += char;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/gu, "$1"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Extension `name` fields are often slugs; read them as words. */
function themeName(value: Record<string, unknown>): string {
  for (const candidate of [value.displayName, value.name]) {
    if (typeof candidate !== "string" || !candidate.trim()) continue;
    const trimmed = candidate.trim();
    const words = /\s/u.test(trimmed) ? trimmed : trimmed.split(/[-_.]+/u).filter(Boolean).map((word) => word[0]!.toUpperCase() + word.slice(1)).join(" ");
    if (words) return words.slice(0, 48);
  }
  return "Imported theme";
}

/** Which VS Code workbench keys a token is read from, first match wins; `text` ones must stay readable. */
const SURFACE_KEYS: ReadonlyArray<readonly [token: string, keys: readonly string[]]> = [
  ["--rail", ["sideBar.background", "activityBar.background"]],
  ["--chrome", ["titleBar.activeBackground", "editorGroupHeader.tabsBackground", "sideBar.background"]],
  ["--field", ["input.background", "dropdown.background"]],
  ["--overlay", ["editorWidget.background", "quickInput.background"]],
  ["--float", ["menu.background", "editorWidget.background", "dropdown.background"]],
  ["--hover", ["list.hoverBackground"]],
  ["--thread-active", ["list.activeSelectionBackground", "list.inactiveSelectionBackground"]],
  ["--code-bg", ["textCodeBlock.background", "terminal.background"]],
  ["--line", ["panel.border", "editorGroup.border", "sideBar.border", "contrastBorder"]],
  ["--line-field", ["input.border", "dropdown.border"]],
  ["--line-focus", ["focusBorder"]],
  ["--scrollbar", ["scrollbarSlider.background"]],
  ["--scrollbar-hover", ["scrollbarSlider.hoverBackground"]],
  ["--diff-add-bg", ["diffEditor.insertedLineBackground", "diffEditor.insertedTextBackground"]],
  ["--diff-del-bg", ["diffEditor.removedLineBackground", "diffEditor.removedTextBackground"]],
];

const TEXT_KEYS: ReadonlyArray<readonly [token: string, keys: readonly string[], on: string]> = [
  ["--muted", ["descriptionForeground"], "--shell"],
  ["--working", ["editorWarning.foreground", "terminal.ansiYellow"], "--shell"],
  ["--warn", ["editorWarning.foreground", "terminal.ansiYellow"], "--shell"],
  ["--ready", ["terminal.ansiGreen", "gitDecoration.addedResourceForeground"], "--shell"],
  ["--removed", ["gitDecoration.deletedResourceForeground", "terminal.ansiRed"], "--shell"],
  ["--danger", ["errorForeground", "editorError.foreground"], "--shell"],
  ["--fail", ["editorError.foreground", "errorForeground"], "--shell"],
  ["--cyan", ["terminal.ansiCyan", "symbolIcon.typeParameterForeground"], "--shell"],
  ["--info", ["terminal.ansiBlue", "editorInfo.foreground"], "--shell"],
  ["--merged", ["terminal.ansiMagenta", "terminal.ansiBrightMagenta"], "--shell"],
  ["--diff-add-ink", ["gitDecoration.addedResourceForeground", "terminal.ansiGreen"], "--diff-add-bg"],
  ["--diff-del-ink", ["gitDecoration.deletedResourceForeground", "terminal.ansiRed"], "--diff-del-bg"],
];

/**
 * A VS Code colour theme (`*-color-theme.json`) as Tau tokens. VS Code themes
 * describe editor chrome and leave most keys unset, so the palette is derived
 * from the editor's background, foreground and accent first, and what the file
 * does specify is laid over it: translucent colours flattened onto the surface
 * under them, text colours only where they stay readable there.
 */
export function importVsCodeTheme(source: string | unknown): ImportedTheme {
  const value = typeof source === "string" ? parseJsonc(source) : source;
  if (!isRecord(value)) throw new Error("A theme file holds one JSON object.");
  const colors = isRecord(value.colors) ? value.colors : {};
  const pick = (keys: readonly string[]): Rgba | undefined => {
    for (const key of keys) {
      const parsed = parseHex(colors[key]);
      if (parsed) return parsed;
    }
    return undefined;
  };
  const canvas = pick(["editor.background", "editorPane.background"]);
  if (!canvas) throw new Error("This theme has no editor.background colour, so there is nothing to build a palette from.");
  const background = flatten({ ...canvas, a: 1 }, "#000000");
  const type = typeof value.type === "string" ? value.type.toLowerCase() : "";
  const appearance: Appearance = type === "light" || type === "hc-light" ? "light" : type === "dark" || type === "hc-black" ? "dark" : isDark(background) ? "dark" : "light";
  const fallbackInk = appearance === "dark" ? "#e9e6e0" : "#1c1b19";
  const foregroundColor = pick(["editor.foreground", "foreground"]);
  const foreground = foregroundColor ? readable(flatten(foregroundColor, background), background, fallbackInk) : fallbackInk;
  const accentColor = pick(["focusBorder", "button.background", "textLink.foreground", "activityBarBadge.background", "progressBar.background"]);
  const accent = accentColor ? flatten(accentColor, background) : appearance === "dark" ? "#6b93e0" : "#4b75c5";

  const tokens = derivePalette({ appearance, background, foreground, accent });
  for (const [token, keys] of SURFACE_KEYS) {
    const color = pick(keys);
    if (color) tokens[token] = flatten(color, token === "--diff-add-bg" || token === "--diff-del-bg" ? tokens["--code-bg"]! : background);
  }
  for (const [token, keys, on] of TEXT_KEYS) {
    const color = pick(keys);
    const surface = tokens[on] ?? background;
    if (!color) continue;
    const flat = flatten(color, surface);
    if (contrast(flat, surface) >= 4.5) tokens[token] = flat;
    else if (contrast(flat, surface) >= 3) tokens[token] = readable(flat, surface, tokens["--ink"]!);
  }
  const button = pick(["button.background"]);
  if (button) {
    tokens["--acid"] = flatten(button, background);
    tokens["--acid-ink"] = contrast("#000000", tokens["--acid"]) >= contrast("#ffffff", tokens["--acid"]) ? "#000000" : "#ffffff";
    const buttonInk = pick(["button.foreground"]);
    if (buttonInk && contrast(flatten(buttonInk, tokens["--acid"]), tokens["--acid"]) >= 4.5) tokens["--acid-ink"] = flatten(buttonInk, tokens["--acid"]);
  }
  return { name: themeName(value), appearance, tokens, seed: { background, foreground, accent } };
}
