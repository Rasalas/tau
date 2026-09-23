/** The mode every runtime has: turns run as the user asked. */
export const DEFAULT_THREAD_MODE = "default";

/**
 * The custom entry a Pi thread records its interaction mode in, `{ mode }`.
 * It lives in the session file, so the mode survives a restart and a Pi
 * extension reads it from `ctx.sessionManager` without asking the host.
 */
export const THREAD_MODE_ENTRY = "tau.mode";

/** The mode the last `tau.mode` entry on a branch names; `default` without one. */
export function threadModeFromEntries(entries: readonly unknown[]): string {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as { type?: unknown; customType?: unknown; data?: { mode?: unknown } } | undefined;
    if (entry?.type !== "custom" || entry.customType !== THREAD_MODE_ENTRY) continue;
    return typeof entry.data?.mode === "string" && entry.data.mode ? entry.data.mode : DEFAULT_THREAD_MODE;
  }
  return DEFAULT_THREAD_MODE;
}

/** Whether `mode` is one a runtime offering `modes` accepts. */
export function isOfferedMode(mode: string, modes: readonly string[] | undefined): boolean {
  return mode === DEFAULT_THREAD_MODE || (modes?.includes(mode) ?? false);
}
