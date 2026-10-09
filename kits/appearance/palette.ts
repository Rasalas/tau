import { contrast, mix, readable } from "./color.js";
import type { Appearance } from "./protocol.js";

export interface PaletteSeed {
  appearance: Appearance;
  /** The window. */
  background: string;
  /** Headings and body text. */
  foreground: string;
  accent: string;
}

/** How a surface sits against the window: toward the ink, lifted toward white (or the ink, in the dark), or deeper. */
type Step = readonly ["ink" | "lift" | "deep", number, number?];

/** Offsets read off Tau's own two token sets; the optional second number is the light scheme's own amount. */
const SURFACES: Readonly<Record<string, Step>> = {
  "--well": ["deep", 0.3],
  "--rail": ["ink", 0.04],
  "--chrome": ["ink", 0.04],
  "--stage": ["lift", 0, 0],
  "--sunken": ["ink", 0.02],
  "--field": ["ink", 0.04],
  "--thread-active": ["lift", 0, 0],
  "--raised": ["ink", 0.1],
  "--raised-strong": ["ink", 0.127, 0.15],
  "--raised-hover": ["ink", 0.163, 0.1875],
  "--overlay": ["lift", 0.05, 0],
  "--float": ["lift", 0.05, 0],
  "--hover": ["ink", 0.075],
  "--hover-strong": ["ink", 0.09],
  "--code-bg": ["ink", 0.04],
  "--inset": ["ink", 0.04],
  "--chip": ["ink", 0.094, 0.10625],
  "--chip-hover": ["ink", 0.15, 0.15],
  "--track": ["ink", 0.15, 0.15],
};

const HAIRLINES: Readonly<Record<string, number>> = {
  "--line": 0.09, "--line-soft": 0.07, "--line-inset": 0.06, "--line-card": 0.11, "--line-control": 0.12,
  "--line-strong": 0.15, "--line-field": 0.18, "--line-focus": 0.28, "--line-float": 0.24, "--line-hover": 0.32,
};

/** How far each ink sits from the foreground toward the background, and the contrast it must keep. */
const INKS: Readonly<Record<string, readonly [number, number]>> = {
  "--ink-prose": [0.2, 4.5], "--ink-2": [0.14, 4.5], "--ink-3": [0.3, 4.5], "--ink-code": [0.2, 4.5],
  "--muted": [0.42, 4.5], "--muted-2": [0.5, 3], "--faint": [0.58, 3], "--fainter": [0.72, 1],
};

/**
 * A whole palette from three colours: the surfaces, hairlines, ink and accent
 * tokens. Status and diff colours are left to Tau's defaults for the scheme.
 * Every ink that carries text is pushed back toward the foreground until it
 * reads on the window and the document area.
 */
export function derivePalette(seed: PaletteSeed): Record<string, string> {
  const { appearance, background: bg, foreground: fg, accent } = seed;
  const white = "#ffffff";
  const black = "#000000";
  const tokens: Record<string, string> = { "--shell": bg };
  for (const [name, [kind, amount, light]] of Object.entries(SURFACES)) {
    if (kind === "ink") tokens[name] = mix(bg, fg, appearance === "light" ? light ?? amount * 1.25 : amount);
    else if (kind === "lift") tokens[name] = appearance === "light" ? mix(bg, white, light ?? amount) : mix(bg, fg, amount);
    else tokens[name] = appearance === "light" ? mix(bg, fg, light ?? amount / 5) : mix(bg, black, amount);
  }
  for (const [name, amount] of Object.entries(HAIRLINES)) tokens[name] = mix(bg, fg, appearance === "light" ? amount * 1.2 : amount);
  const stage = tokens["--stage"]!;
  tokens["--ink"] = readable(fg, bg, appearance === "light" ? black : white, 7);
  for (const [name, [amount, ratio]] of Object.entries(INKS)) {
    const start = mix(tokens["--ink"], bg, amount);
    tokens[name] = contrast(start, stage) >= ratio && contrast(start, bg) >= ratio ? start : readable(readable(start, bg, tokens["--ink"], ratio), stage, tokens["--ink"], ratio);
  }
  tokens["--scrollbar"] = mix(bg, fg, 0.18);
  tokens["--scrollbar-hover"] = mix(bg, fg, 0.28);

  tokens["--acid"] = accent;
  tokens["--acid-strong"] = mix(accent, appearance === "light" ? black : white, 0.12);
  tokens["--acid-ink"] = contrast(black, accent) >= contrast(white, accent) ? mix(black, accent, 0.08) : white;
  tokens["--acid-text"] = readable(readable(accent, bg, tokens["--ink"]), stage, tokens["--ink"]);
  tokens["--acid-bg"] = mix(bg, accent, 0.1);
  tokens["--acid-line"] = mix(bg, accent, 0.35);
  tokens["--acid-chip"] = mix(bg, accent, 0.2);
  tokens["--acid-track"] = mix(bg, accent, 0.45);
  tokens["--focus"] = tokens["--acid-text"];
  tokens["--user-bubble"] = tokens["--acid-bg"];
  tokens["--user-bubble-ink"] = readable(mix(tokens["--ink"], accent, 0.25), tokens["--user-bubble"], tokens["--ink"]);
  return tokens;
}
