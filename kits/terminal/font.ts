import type { TerminalFontDefaults } from "./protocol.js";

/**
 * Which font a terminal draws with. xterm measures its cell on a canvas,
 * where neither a CSS variable nor `ui-monospace` resolves — a string the
 * canvas cannot parse is dropped whole and the cell is measured in its 10px
 * default while the rows draw in another face. So the stack is concrete names
 * only, ending in the platform's own monospace faces and the Nerd Font glyph
 * fallbacks prompts use.
 */

export const DEFAULT_TERMINAL_FONT_SIZE = 12;
export const MIN_TERMINAL_FONT_SIZE = 6;
export const MAX_TERMINAL_FONT_SIZE = 32;

/** Keys under the kit's own preference values. */
export const FONT_FAMILY_SETTING = "fontFamily";
export const FONT_SIZE_SETTING = "fontSize";

const PLATFORM_FACES = ["SF Mono", "SFMono-Regular", "Menlo", "Consolas", "Liberation Mono"];
const GLYPH_FALLBACKS = [
  "Symbols Nerd Font Mono", "Symbols Nerd Font", "JetBrainsMono Nerd Font", "JetBrainsMono NF",
  "FiraCode Nerd Font", "Hack Nerd Font", "MesloLGS NF", "CaskaydiaCove Nerd Font", "PowerlineSymbols",
];
const GENERIC_FAMILIES = new Set(["monospace", "serif", "sans-serif"]);

/** Splits `"JetBrains Mono", Menlo` into its names, keeping commas inside quotes. */
export function splitFamilyList(text: string): string[] {
  const names: string[] = [];
  let current = "";
  let quote: string | undefined;
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
    } else if (char === "\"" || char === "'") {
      quote = char;
    } else if (char === ",") {
      names.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  names.push(current);
  return names.map((name) => name.trim().replace(/\s+/gu, " ")).filter(Boolean);
}

/** A name as the stack spells it: quoted, a generic keyword bare, or nothing for what a canvas cannot resolve. */
export function cssFamilyName(name: string): string | undefined {
  const bare = name.trim().replace(/^(["'])(.*)\1$/u, "$2").trim();
  if (!bare || bare.startsWith("var(") || /^ui-/iu.test(bare) || /^system-ui$/iu.test(bare)) return undefined;
  if (GENERIC_FAMILIES.has(bare.toLowerCase())) return bare.toLowerCase();
  return `"${bare.replace(/["\\]/gu, "")}"`;
}

/** The chosen faces first, then the platform faces and the glyph fallbacks; each name once. */
export function terminalFontStack(families: readonly string[] = []): string {
  const chosen = families.flatMap(splitFamilyList).map(cssFamilyName).filter((name): name is string => Boolean(name))
    .filter((name) => name !== "monospace");
  const stack = [...chosen, ...[...PLATFORM_FACES, ...GLYPH_FALLBACKS].map((name) => `"${name}"`), "monospace"];
  const seen = new Set<string>();
  return stack.filter((name) => {
    const key = name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).join(", ");
}

/** A size the grid can draw: clamped, and to the half pixel. */
export function terminalFontSize(size: number | undefined): number {
  if (size === undefined || !Number.isFinite(size) || size <= 0) return DEFAULT_TERMINAL_FONT_SIZE;
  return Math.min(MAX_TERMINAL_FONT_SIZE, Math.max(MIN_TERMINAL_FONT_SIZE, Math.round(size * 2) / 2));
}

export type TerminalFontSource = "settings" | "ghostty" | "default";

export interface ResolvedTerminalFont {
  /** The whole stack, ready for xterm's `fontFamily`. */
  family: string;
  size: number;
  /** The face asked for first, for the settings page to name; absent for the platform default. */
  face?: string;
  familySource: TerminalFontSource;
  sizeSource: TerminalFontSource;
}

/** What the user typed in the kit's settings; empty strings mean "not set". */
export interface TerminalFontSettings {
  family?: string;
  size?: string;
}

/**
 * Settings win, then the user's Ghostty config, then the platform faces —
 * family and size each on their own, so setting one keeps the other.
 */
export function resolveTerminalFont(settings: TerminalFontSettings, ghostty?: TerminalFontDefaults): ResolvedTerminalFont {
  const typed = settings.family?.trim() ? splitFamilyList(settings.family) : [];
  const families = typed.length > 0 ? typed : ghostty?.families ?? [];
  const familySource: TerminalFontSource = typed.length > 0 ? "settings" : families.length > 0 ? "ghostty" : "default";
  const typedSize = settings.size?.trim() ? Number(settings.size) : Number.NaN;
  const sizeSource: TerminalFontSource = Number.isFinite(typedSize) && typedSize > 0 ? "settings" : ghostty?.size ? "ghostty" : "default";
  const size = terminalFontSize(sizeSource === "settings" ? typedSize : sizeSource === "ghostty" ? ghostty?.size : undefined);
  const face = families.flatMap(splitFamilyList).find((name) => cssFamilyName(name) && !GENERIC_FAMILIES.has(name.toLowerCase()));
  return { family: terminalFontStack(families), size, ...(face ? { face } : {}), familySource, sizeSource };
}
