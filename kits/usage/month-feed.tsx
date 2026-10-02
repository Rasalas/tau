import { useSyncExternalStore } from "react";
import { formatCost, tooltipProps, usePreferences, type HostExtensionClient, type PageSummaryProps } from "tau";
import { useRunEnded } from "./juicebars-view.js";
import { monthStart } from "./month.js";
import { USAGE_PAGE, USAGE_SUMMARY_COMMAND, type UsageSummary, type UsageTotals } from "./protocol.js";
import { formatTokens } from "./view-model.js";

/** One month read for the sidebar, delayed until startup settles and refreshed after runs. */
export function createMonthFeed(host: HostExtensionClient, now: () => Date = () => new Date()) {
  let totals: UsageTotals | undefined;
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  let busy = false;
  const schedule = (ms: number) => {
    clearTimeout(timer);
    timer = setTimeout(() => void read(), ms);
  };
  const read = async () => {
    if (busy) return;
    busy = true;
    try {
      const summary = await host.invoke(USAGE_SUMMARY_COMMAND, { since: monthStart(now()) }) as UsageSummary;
      totals = summary.totals;
      for (const listener of [...listeners]) listener();
      if (summary.reading && listeners.size) schedule(5_000);
    } catch {
      // Keep the last figure; Usage's page reports source failures.
    } finally {
      busy = false;
    }
  };
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) {
        schedule(2_000);
        poll = setInterval(() => { if (document.visibilityState === "visible") void read(); }, 5 * 60_000);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size) return;
        clearTimeout(timer);
        clearInterval(poll);
      };
    },
    getSnapshot: () => totals,
    runEnded: () => { if (listeners.size) schedule(3_000); },
  };
}

/** Billed money only, before the plan bars. The hint keeps the thread and token counts. */
export function MonthCost({ actions, feed }: PageSummaryProps & { feed: ReturnType<typeof createMonthFeed> }) {
  const totals = useSyncExternalStore(feed.subscribe, feed.getSnapshot);
  const preferences = usePreferences();
  const showCosts = useSyncExternalStore(preferences.subscribe, () => preferences.getSnapshot().showCosts);
  useRunEnded(feed);
  const price = totals && showCosts ? formatCost(totals.costUsd) : undefined;
  if (!price || !totals) return null;
  const hint = `This month · ${price} billed per token · ${totals.threads} ${totals.threads === 1 ? "thread" : "threads"} · ${formatTokens(totals.totalTokens)} tokens`;
  return <button type="button" className="sidebar-summary" {...tooltipProps(hint, { side: "top" })} aria-label={`Usage: ${hint}`} onClick={() => actions.openPage?.(USAGE_PAGE)}>{price}</button>;
}
