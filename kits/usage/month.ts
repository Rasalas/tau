import { useEffect, useRef, useSyncExternalStore } from "react";
import { formatCost, usePreferences, useThreadStore, type HostExtensionClient, type PageSummary } from "tau";
import { USAGE_SUMMARY_COMMAND, type UsageSummary, type UsageSummaryInput, type UsageTotals } from "./protocol.js";
import { formatTokens } from "./view-model.js";

/** Nothing is read before the window has settled after start. */
export const MONTH_FIRST_READ_MS = 2_000;
/** How often the foot reads again while the window is seen. */
export const MONTH_POLL_MS = 5 * 60_000;
/** A run that ended is in the host's records a moment later; the foot asks then. */
export const MONTH_AFTER_RUN_MS = 3_000;
/** While the host still reads the CLIs' logs. */
const MONTH_READING_MS = 5_000;

/** Local midnight on the first of `now`'s month. */
export function monthStart(now: Date): number {
  return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
}

/**
 * The design's "$12.40 · 22 · 3.1M tok": money billed per token, threads and
 * tokens this month. A plan's value is never added to what was billed; it is
 * only named in the hint. Without costs shown, the money goes.
 */
export function monthSummary(totals: UsageTotals, showCosts: boolean): PageSummary | undefined {
  if (totals.threads === 0 && totals.totalTokens === 0) return undefined;
  const billed = showCosts ? formatCost(totals.costUsd) : undefined;
  const plan = showCosts ? formatCost(totals.subscription.apiValueUsd) : undefined;
  const tokens = `${formatTokens(totals.totalTokens)} tok`;
  const threads = `${totals.threads} ${totals.threads === 1 ? "thread" : "threads"}`;
  const hint = [
    "This month",
    billed ? `${billed} billed per token` : undefined,
    plan ? `plans worth ≈ ${plan} at API prices` : undefined,
    threads,
    `${formatTokens(totals.totalTokens)} tokens`,
  ].filter(Boolean).join(" · ");
  return { text: [billed, String(totals.threads), tokens].filter(Boolean).join(" · "), short: billed ?? tokens, hint };
}

interface MonthState { totals?: UsageTotals }

/** One read of this month for the whole window, whoever draws it; started by the first reader. */
export function createMonthUsage(host: HostExtensionClient, now: () => Date = () => new Date()) {
  let state: MonthState = {};
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  let busy = false;

  const read = async () => {
    timer = undefined;
    if (busy) return;
    busy = true;
    try {
      const input: UsageSummaryInput = { since: monthStart(now()) };
      const summary = await host.invoke(USAGE_SUMMARY_COMMAND, input) as UsageSummary;
      state = { totals: summary.totals };
      for (const listener of listeners) listener();
      if (summary.reading && listeners.size) schedule(MONTH_READING_MS);
    } catch {
      // The foot keeps the icon; the page says what failed.
    } finally {
      busy = false;
    }
  };
  const schedule = (ms: number) => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => void read(), ms);
  };

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      if (listeners.size === 1) {
        schedule(state.totals ? 0 : MONTH_FIRST_READ_MS);
        poll = setInterval(() => { if (document.visibilityState === "visible") void read(); }, MONTH_POLL_MS);
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
    getSnapshot: (): MonthState => state,
    /** A run ended: read again once its turn is in the records. */
    runEnded(): void { if (listeners.size) schedule(MONTH_AFTER_RUN_MS); },
  };
}

export type MonthUsage = ReturnType<typeof createMonthUsage>;

/** The page's `useSummary`: this month's figure, read again after every run that ends. */
export function monthSummaryHook(month: MonthUsage): () => PageSummary | undefined {
  return function useMonthSummary() {
    const { totals } = useSyncExternalStore(month.subscribe, month.getSnapshot);
    const preferences = usePreferences();
    const showCosts = useSyncExternalStore(preferences.subscribe, () => preferences.getSnapshot().showCosts);
    const threads = useThreadStore();
    const running = useSyncExternalStore(threads.subscribeToActivity, () => threads.getActivity().runningThreadIds.length);
    const last = useRef(running);
    useEffect(() => {
      if (running < last.current) month.runEnded();
      last.current = running;
    }, [running]);
    return totals ? monthSummary(totals, showCosts) : undefined;
  };
}
