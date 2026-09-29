import type { HostExtensionClient, PlatformEnvironments } from "tau";
import { dayStarts, HISTORY_DAYS } from "./dashboard.js";
import { readLastState } from "./last-state.js";
import { mergeLimits, otherMachines, readMachines } from "./machines.js";
import { USAGE_LIMITS_COMMAND, type UsageLimitsSummary } from "./protocol.js";

/** Nothing is read before the window has settled after start. */
export const LIMITS_FIRST_READ_MS = 2_000;
/** How often the foot reads again while the window is seen; the host answers from its own five-minute cache. */
export const LIMITS_POLL_MS = 5 * 60_000;
/** A run that ended may have moved a plan's windows; its runtime reports them a moment later. */
export const LIMITS_AFTER_RUN_MS = 3_000;

/**
 * One read of every machine's limits for the whole window, whoever draws
 * them: the sidebar's juicebars, and the Usage page, which hands over what it
 * read itself. It starts with the page's last known reading.
 */
export function createLimitsFeed(host: HostExtensionClient, environments?: PlatformEnvironments) {
  let limits: UsageLimitsSummary | undefined;
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  let busy = false;

  const publish = (next: UsageLimitsSummary | undefined): void => {
    // An older answer never replaces a newer one.
    if (!next || (limits && next.checkedAt < limits.checkedAt)) return;
    limits = next;
    for (const listener of [...listeners]) listener();
  };
  const read = async (): Promise<void> => {
    timer = undefined;
    if (busy) return;
    busy = true;
    try {
      const [local, others] = await Promise.all([
        host.invoke(USAGE_LIMITS_COMMAND, {}).then((answer) => answer as UsageLimitsSummary, () => undefined),
        readMachines(environments, otherMachines(environments), USAGE_LIMITS_COMMAND, {}),
      ]);
      publish(mergeLimits(local, others.map((entry) => ({ machine: entry.machine, ...(entry.answer ? { limits: entry.answer as UsageLimitsSummary } : {}) }))));
    } finally {
      busy = false;
    }
  };
  const schedule = (ms: number): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => void read(), ms);
  };

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      if (listeners.size === 1) {
        limits ??= readLastState(environments?.shownElsewhere, dayStarts(HISTORY_DAYS))?.limits;
        schedule(LIMITS_FIRST_READ_MS);
        poll = setInterval(() => { if (document.visibilityState === "visible") void read(); }, LIMITS_POLL_MS);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size) return;
        if (timer !== undefined) clearTimeout(timer);
        if (poll !== undefined) clearInterval(poll);
        timer = undefined;
        poll = undefined;
      };
    },
    getSnapshot: (): UsageLimitsSummary | undefined => limits,
    publish,
    /** A run ended: read again once its runtime has reported. */
    runEnded(): void { if (listeners.size) schedule(LIMITS_AFTER_RUN_MS); },
  };
}

export type LimitsFeed = ReturnType<typeof createLimitsFeed>;
