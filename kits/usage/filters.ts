import { getClientStorage } from "tau";
import type { UsageMetric, UsageOrigin, UsageRange } from "./dashboard.js";
import type { UsageMachine } from "./machines.js";
import type { MonthFigures } from "./month.js";

/** The device's own, whatever host it shows: a phone keeps one choice for all its hosts. */
const HIDDEN_RUNTIMES_KEY = "device:tau.usage.hidden-runtimes";

/** The hidden set is kept, not the shown one, so a runtime that appears later is shown. */
function readHiddenRuntimes(): readonly string[] | undefined {
  try {
    const stored = JSON.parse(getClientStorage()?.get(HIDDEN_RUNTIMES_KEY) ?? "null") as unknown;
    const hidden = Array.isArray(stored) ? stored.filter((item): item is string => typeof item === "string") : [];
    return hidden.length > 0 ? hidden : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What the page shows: a period, a measure, the runtimes left out (activity,
 * limits and accounts alike), and one machine or origin or all.
 */
export interface UsageFilters {
  range: UsageRange;
  metric: UsageMetric;
  /** Runtimes switched off; kept on this device. Absent when none is. */
  hiddenRuntimes?: readonly string[];
  /** `""` this computer, a host id another machine. */
  machine?: string;
  origin?: UsageOrigin;
}

/** What the page read that the filters offer, and this month's figure; the sidebar draws from it. */
export interface UsageFacts {
  runtimes: readonly string[];
  machines: readonly UsageMachine[];
  anyOutside: boolean;
  month?: MonthFigures;
}

const EMPTY_FACTS: UsageFacts = { runtimes: [], machines: [], anyOutside: false };

/**
 * The Usage page and its sidebar in two places of the window: the filters
 * either one sets, and what the page read for the sidebar to offer. Kept for
 * the window's run, so the page opens again as it was left.
 */
export function createUsageView() {
  let filters: UsageFilters | undefined;
  let facts = EMPTY_FACTS;
  const listeners = new Set<() => void>();
  const changed = () => { for (const listener of [...listeners]) listener(); };
  const current = (): UsageFilters => {
    // Read on first use: the client's storage may not exist yet when the kit registers.
    if (!filters) {
      const hidden = readHiddenRuntimes();
      filters = { range: "month", metric: "cost", ...(hidden ? { hiddenRuntimes: hidden } : {}) };
    }
    return filters;
  };
  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    getFilters: current,
    getFacts: (): UsageFacts => facts,
    setFilters(patch: Partial<UsageFilters>): void {
      const next = { ...current(), ...patch };
      for (const key of Object.keys(next) as Array<keyof UsageFilters>) if (next[key] === undefined) delete next[key];
      if (next.hiddenRuntimes?.length === 0) delete next.hiddenRuntimes;
      filters = next;
      if ("hiddenRuntimes" in patch) {
        try { getClientStorage()?.set(HIDDEN_RUNTIMES_KEY, JSON.stringify(next.hiddenRuntimes ?? [])); } catch { /* kept for this run */ }
      }
      changed();
    },
    setFacts(next: UsageFacts): void {
      facts = next;
      changed();
    },
  };
}

export type UsageView = ReturnType<typeof createUsageView>;

/** The runtimes left out after one is switched on or off; `runtimes` are all that are offered. */
export function toggleRuntime(hidden: readonly string[] | undefined, runtime: string): string[] {
  const set = new Set(hidden);
  if (!set.delete(runtime)) set.add(runtime);
  return [...set];
}
