import type { Appearance, SaveThemeInput } from "./protocol.js";

/** One theme's tokens per scheme; a scheme it does not set is empty. */
export interface SchemeTokens { light: Record<string, string>; dark: Record<string, string> }

/** The file the editor saves: a Tau user theme, one scheme, one rule. */
export function themeFileCss(theme: SaveThemeInput): string {
  const lines = [
    `/* theme: ${theme.name.replace(/\*\//gu, "")} */`,
    "/* Written by Tau's theme editor; a user theme like any other .css file here. */",
    `:root, :root[data-theme="${theme.id}"] {`,
    `  color-scheme: ${theme.appearance};`,
    ...Object.entries(theme.tokens).map(([name, value]) => `  ${name}: ${value};`),
    "}",
    "",
  ];
  return lines.join("\n");
}

/** Splits `a, b` at the top-level comma only. */
function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === "," && depth === 0) { parts.push(value.slice(start, index).trim()); start = index + 1; }
  }
  parts.push(value.slice(start).trim());
  return parts;
}

/** `light-dark(a, b)` as its two sides; any other value is both. */
export function schemeSides(value: string): { light: string; dark: string } {
  const match = /^light-dark\((.*)\)$/su.exec(value.trim());
  const sides = match ? splitTopLevel(match[1]!) : [];
  return sides.length === 2 ? { light: sides[0]!, dark: sides[1]! } : { light: value.trim(), dark: value.trim() };
}

/**
 * The custom properties a user theme's stylesheet sets, per scheme. A value
 * written once belongs to the scheme the sheet declares with `color-scheme`
 * (or `base`), and to both when it declares none.
 */
export function parseThemeCss(css: string, base?: string): SchemeTokens {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//gu, "");
  const scheme = /color-scheme\s*:\s*(light|dark)\b/u.exec(withoutComments)?.[1] ?? (base === "light" || base === "dark" ? base : undefined);
  const result: SchemeTokens = { light: {}, dark: {} };
  for (const [, name, raw] of withoutComments.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+);/gu)) {
    const value = raw!.trim();
    const sides = schemeSides(value);
    const isPair = value.startsWith("light-dark(");
    if (isPair || !scheme || scheme === "light") result.light[name!] = sides.light;
    if (isPair || !scheme || scheme === "dark") result.dark[name!] = sides.dark;
  }
  return result;
}

function declarations(tokens: Readonly<Record<string, string>>): string {
  return Object.entries(tokens).filter(([, value]) => !/[;{}<]/u.test(value)).map(([name, value]) => `${name}: ${value};`).join(" ");
}

/** Hairlines and the quieter inks, pulled toward the ink by the contrast setting. */
const CONTRAST_TOKENS: ReadonlyArray<readonly [name: string, weight: number]> = [
  ["--line", 0.35], ["--line-soft", 0.35], ["--line-inset", 0.35], ["--line-card", 0.35], ["--line-control", 0.35],
  ["--line-strong", 0.35], ["--line-field", 0.35], ["--ink-3", 0.5], ["--muted", 0.5], ["--muted-2", 0.5], ["--faint", 0.5], ["--fainter", 0.5],
];

export interface RuntimeAppearance {
  /** A theme's tokens for the light scheme, for System and Light. */
  light?: Readonly<Record<string, string>>;
  /** And for the dark one. */
  dark?: Readonly<Record<string, string>>;
  /** 0 to 100: how far hairlines and quiet inks move toward the ink. */
  contrast: number;
}

/**
 * The stylesheet the kit keeps in the page. A theme per scheme applies while
 * the preference is System, Light or Dark (a theme chosen as the preference
 * itself is core's). Contrast is pure CSS: <html> keeps the token under
 * another name and <body> mixes it toward the ink, which is no cycle because
 * they are two elements.
 */
export function runtimeCss(appearance: RuntimeAppearance): string {
  const rules: string[] = [];
  const light = appearance.light && Object.keys(appearance.light).length > 0 ? declarations(appearance.light) : "";
  const dark = appearance.dark && Object.keys(appearance.dark).length > 0 ? declarations(appearance.dark) : "";
  if (light) rules.push(`:root[data-theme="light"] { ${light} }`, `@media (prefers-color-scheme: light) { :root[data-theme="system"] { ${light} } }`);
  if (dark) rules.push(`:root[data-theme="dark"] { ${dark} }`, `@media (prefers-color-scheme: dark) { :root[data-theme="system"] { ${dark} } }`);
  const amount = Math.max(0, Math.min(100, Math.round(appearance.contrast)));
  if (amount > 0) {
    rules.push(`:root { ${CONTRAST_TOKENS.map(([name]) => `--tau-appearance-base${name.slice(1)}: var(${name});`).join(" ")} }`);
    rules.push(`body { ${CONTRAST_TOKENS.map(([name, weight]) => `${name}: color-mix(in oklab, var(--tau-appearance-base${name.slice(1)}), var(--ink) ${Math.round(amount * weight)}%);`).join(" ")} }`);
  }
  return rules.join("\n");
}

/** The editor's draft on the whole window, in the scheme it edits. */
export function previewCss(appearance: Appearance, tokens: Readonly<Record<string, string>>): string {
  return `:root:root { color-scheme: ${appearance}; ${declarations(tokens)} }`;
}
