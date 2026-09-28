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
