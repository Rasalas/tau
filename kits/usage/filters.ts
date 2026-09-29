import type { UsageMetric, UsageOrigin, UsageRange } from "./dashboard.js";
import type { UsageMachine } from "./machines.js";
import type { MonthFigures } from "./month.js";

/** What the Activity section shows: a period, a measure, and one runtime, machine or origin or all. */
export interface UsageFilters {
  range: UsageRange;
  metric: UsageMetric;
  runtime?: string;
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
  let filters: UsageFilters = { range: "30d", metric: "cost" };
  let facts = EMPTY_FACTS;
  const listeners = new Set<() => void>();
  const changed = () => { for (const listener of [...listeners]) listener(); };
  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    getFilters: (): UsageFilters => filters,
    getFacts: (): UsageFacts => facts,
    setFilters(patch: Partial<UsageFilters>): void {
      const next = { ...filters, ...patch };
      for (const key of Object.keys(next) as Array<keyof UsageFilters>) if (next[key] === undefined) delete next[key];
      filters = next;
      changed();
    },
    setFacts(next: UsageFacts): void {
      facts = next;
      changed();
    },
  };
}

export type UsageView = ReturnType<typeof createUsageView>;
