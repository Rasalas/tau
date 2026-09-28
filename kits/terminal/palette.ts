import type { ITheme } from "@xterm/xterm";

/** Readable on the light theme's paper, in the design's ink, green, red and blue. */
export const LIGHT_ANSI: ITheme = {
  black: "#1c1b19", red: "#b3261e", green: "#2d7a3a", yellow: "#8a6100", blue: "#3b63b0", magenta: "#8a3f9e", cyan: "#16727e", white: "#6f6a62",
  brightBlack: "#57534c", brightRed: "#c9372c", brightGreen: "#338a43", brightYellow: "#9c6f00", brightBlue: "#4b75c5", brightMagenta: "#9d4fb2", brightCyan: "#1b8492", brightWhite: "#8f887e",
};

/** Whether a computed `rgb(…)` colour is a light ground. */
export function isLightGround(color: string | undefined): boolean {
  const [r = 0, g = 0, b = 0] = (color?.match(/[\d.]+/gu) ?? []).map(Number);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 140;
}

/** xterm's own ANSI colours are made for a dark ground; on a light one yellow and white vanish. */
export function forGround(theme: ITheme): ITheme {
  return isLightGround(theme.background) ? { ...theme, ...LIGHT_ANSI, selectionBackground: "rgba(75, 117, 197, 0.25)" } : theme;
}
