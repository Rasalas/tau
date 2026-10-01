import { useEffect, useState } from "react";
import { formatCost, tooltipProps, type HostExtensionClient, type PageSummaryProps } from "tau";
import { dayStarts, HISTORY_DAYS } from "./dashboard.js";
import { readLastState, saveLastState } from "./last-state.js";
import { monthFigures } from "./month.js";
import { fromRequest, request } from "./page.js";
import { USAGE_PAGE, USAGE_SUMMARY_COMMAND, type UsageSummary } from "./protocol.js";

function monthCost(machine: string | undefined): number | undefined {
  const days = dayStarts(HISTORY_DAYS);
  const entries = readLastState(machine, days)?.summary?.entries;
  return entries && monthFigures(entries, days, new Date()).current.costUsd;
}

/**
 * This month's billed cost at the sidebar's foot (design 1a), from what Usage
 * read last, and read again once the window settled.
 */
export function MonthCost({ actions, host, machine }: PageSummaryProps & { host: HostExtensionClient; machine?: string | undefined }) {
  const [cost, setCost] = useState(() => monthCost(machine));
  useEffect(() => {
    const timer = setTimeout(() => {
      const days = dayStarts(HISTORY_DAYS);
      void host.invoke(USAGE_SUMMARY_COMMAND, { days: request(days) }).then((answer) => {
        saveLastState(machine, { days, summary: fromRequest(answer as UsageSummary) });
        setCost(monthCost(machine));
      }, () => undefined);
    }, 8_000);
    return () => clearTimeout(timer);
  }, [host, machine]);
  if (cost === undefined) return null;
  const text = formatCost(cost) ?? "$0.00";
  return <button type="button" className="usage-month-cost" {...tooltipProps("This month", { side: "top" })} aria-label={`This month: ${text}`}
    onClick={() => actions.openPage?.(USAGE_PAGE)}>{text}</button>;
}
