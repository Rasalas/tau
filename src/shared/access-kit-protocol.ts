import type { AccessLevel } from "./contracts.js";

/**
 * Access Kit's contract between its host entry and its desktop entry. The gate
 * itself is a Pi extension the host entry contributes; core knows none of this.
 */
export const ACCESS_HOST_EXTENSION_ID = "tau.access";

export const ACCESS_LEVELS: ReadonlyArray<{ id: AccessLevel; label: string }> = [
  { id: "read-only", label: "read-only" },
  { id: "ask", label: "ask before edits" },
  { id: "full", label: "full access" },
];

export const DEFAULT_ACCESS_LEVEL: AccessLevel = "full";

export function isAccessLevel(value: unknown): value is AccessLevel {
  return ACCESS_LEVELS.some((level) => level.id === value);
}

export interface AccessHostCommands {
  /** The level the gate currently enforces. */
  "level": { input: undefined; output: AccessLevel };
  "set-level": { input: { level: AccessLevel }; output: AccessLevel };
}

/** Published by the host entry whenever the level changes. */
export const ACCESS_LEVEL_EVENT = "level";
