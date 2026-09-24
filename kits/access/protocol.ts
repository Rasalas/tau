/**
 * Pi itself has no permission model — every tool it is asked to run, runs.
 * Tau enforces these levels through an inline Pi extension that can block tool calls.
 */
export type AccessLevel = "read-only" | "ask" | "full";

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

/** The level's key under `values.tau.access` in the host's config. */
export const ACCESS_LEVEL_KEY = "level";

export function isAccessLevel(value: unknown): value is AccessLevel {
  return ACCESS_LEVELS.some((level) => level.id === value);
}

/** Published by the host entry whenever the level changes. */
export const ACCESS_LEVEL_EVENT = "level";

/** Strictest first: a thread's own level may narrow the workbench's, never widen it. */
const STRICTNESS: Record<AccessLevel, number> = { "read-only": 0, ask: 1, full: 2 };

export function strictestAccessLevel(left: AccessLevel, right: AccessLevel | undefined): AccessLevel {
  return right !== undefined && STRICTNESS[right] < STRICTNESS[left] ? right : left;
}

/**
 * Narrows one thread below the workbench's level, `{ threadId, level }`;
 * `level: null` lifts it again. Kept in memory: the caller owns the durable
 * record and sets it again when the thread's runtime is built.
 */
export const ACCESS_THREAD_LEVEL_COMMAND = "thread-level";

/** Agents Kit applies an agent definition's `access` through it. */
export const ACCESS_THREAD_LEVEL_CALLERS = ["tau.agents"] as const;
