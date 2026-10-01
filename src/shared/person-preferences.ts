import type { TauConfig } from "./contracts.js";

/**
 * How the workbench looks and reads: the person's, whichever machine a page
 * shows (spec `one-workbench-many-machines`, D2). A window showing another
 * machine takes them from its own machine and writes them back there.
 */
export const PERSON_PREFERENCE_KEYS = ["theme", "transcriptDetail", "showCosts", "fontFamily", "fontSize", "vimMode", "keybindings"] as const;

export type PersonPreferences = Pick<TauConfig, (typeof PERSON_PREFERENCE_KEYS)[number]>;

/** The person's part of a config; nothing else passes. */
export function personPreferences(config: unknown): PersonPreferences {
  const raw = config && typeof config === "object" ? config as Record<string, unknown> : {};
  const part: Record<string, unknown> = {};
  for (const key of PERSON_PREFERENCE_KEYS) if (raw[key] !== undefined) part[key] = raw[key];
  return part as PersonPreferences;
}
