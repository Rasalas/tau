/** When this client saw a thread enter and leave a Working section; hosts stamp neither. */
export interface WorkingClock {
  returnedAt(threadId: string): number | undefined;
  workingSince(threadId: string): number | undefined;
}

export interface ObservedWorkingClock extends WorkingClock {
  /**
   * Takes the listed thread ids and those in Working, or null while the section
   * is off. The first call only takes a baseline (`baseline`, else now), so
   * turning the section on never reshuffles the list. Calling it again with the
   * same sets changes nothing.
   */
  observe(listed: readonly string[], working: ReadonlySet<string> | null, baseline?: (threadId: string) => number | undefined): void;
}

/** Thread Rail Kit keeps its own copy for the desktop rail (`createWorkingClock` in `kits/thread-rail/meta.ts`). */
export function createWorkingClock(now: () => number = Date.now): ObservedWorkingClock {
  let last: ReadonlySet<string> | null = null;
  const returned = new Map<string, number>();
  const since = new Map<string, number>();
  return {
    observe(listed, working, baseline) {
      if (working === null) {
        last = null;
        returned.clear();
        since.clear();
        return;
      }
      const present = new Set(listed);
      for (const map of [returned, since]) for (const id of map.keys()) if (!present.has(id)) map.delete(id);
      const at = now();
      for (const id of working) {
        if (!present.has(id) || since.has(id)) continue;
        // Wakes and runs ending inside the section keep the row in place; only a new entry moves it.
        since.set(id, last === null ? baseline?.(id) ?? at : at);
        returned.delete(id);
      }
      for (const id of last ?? []) {
        if (present.has(id) && !working.has(id)) {
          since.delete(id);
          returned.set(id, at);
        }
      }
      last = working;
    },
    returnedAt: (threadId) => returned.get(threadId),
    workingSince: (threadId) => since.get(threadId),
  };
}
