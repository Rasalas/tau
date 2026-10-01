/** Pi's level ids are identifiers; these are how they read in menus and the model picker. */
export const THINKING_LABELS: Readonly<Record<string, string>> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

/** Pi's out-of-the-box reasoning level; shown as the default. */
export const DEFAULT_THINKING = "medium";

const ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** The level another model takes over: the same where it has it, else the next lower, else its lowest. */
export function carriedLevel(level: string, levels: readonly string[]): string {
  if (levels.length === 0 || levels.includes(level)) return level;
  const rank = ORDER.indexOf(level);
  return [...levels].reverse().find((option) => ORDER.indexOf(option) <= rank) ?? levels[0]!;
}
