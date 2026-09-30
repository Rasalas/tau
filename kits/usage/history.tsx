import { formatCost, tooltipProps } from "tau";
import type { DayFigures, UsageMetric } from "./dashboard.js";
import { formatTokens } from "./view-model.js";

const money = (value: number) => formatCost(value) ?? "$0";

function dayLabel(start: number, long = false): string {
  return new Date(start).toLocaleDateString(undefined, long ? { weekday: "short", day: "numeric", month: "short" } : { day: "numeric", month: "short" });
}

/** What a day's bar says on hover, on focus and in the table. */
export function daySummary(day: DayFigures): string {
  const parts = [dayLabel(day.start, true)];
  const billed = formatCost(day.costUsd);
  const plan = formatCost(day.apiValueUsd);
  if (billed) parts.push(`${billed} API spend`);
  if (day.planTokens > 0) parts.push(`${formatTokens(day.planTokens)} plan tokens${plan ? ` (≈ ${plan})` : ""}`);
  parts.push(`${formatTokens(day.totalTokens)} tokens`, `${day.requests} ${day.requests === 1 ? "turn" : "turns"}`);
  return parts.join(" · ");
}

/** A day's two parts in the measure: what was paid per token, and what a plan covered. */
function split(day: DayFigures, metric: UsageMetric): [api: number, plan: number] {
  if (metric === "tokens") return [day.totalTokens - day.planTokens, day.planTokens];
  if (metric === "turns") return [day.requests - day.planRequests, day.planRequests];
  return [day.costUsd, day.apiValueUsd];
}

/**
 * Design 1h's "Per day": a column per day, API spend in the accent on top of
 * what plans covered in grey; in money a plan's part is its value at API prices.
 */
export function UsageHistory({ series, metric, title }: { series: readonly DayFigures[]; metric: UsageMetric; title: string }) {
  const top = Math.max(1e-9, ...series.map((day) => split(day, metric).reduce((sum, value) => sum + value, 0)));
  const share = (value: number) => `${Math.min(100, (value / top) * 100)}%`;
  const labelEvery = series.length > 31 ? 14 : 7;
  const first = series.length > 0 ? new Date(series[0]!.start).getMonth() : -1;
  return (
    <figure className="usage-history usage-card" data-metric={metric}>
      <figcaption className="usage-legend">
        <b>{title}</b>
        <span><i data-part="api" />{metric === "cost" ? "API spend" : metric === "tokens" ? "API tokens" : "API turns"}</span>
        <span {...(metric === "cost" ? tooltipProps("What plans covered, at API prices", { side: "top" }) : {})}><i data-part="plan" />{metric === "cost" ? "plan value" : metric === "tokens" ? "plan tokens" : "plan turns"}</span>
      </figcaption>
      <ol className="usage-chart-bars" aria-label={metric === "tokens" ? "Tokens per day" : metric === "turns" ? "Turns per day" : "Cost per day"}>
        {series.map((day, index) => {
          const summary = daySummary(day);
          const [api, plan] = split(day, metric);
          // The first date names its month, and so does a later one where a month begins.
          const date = new Date(day.start);
          const label = index % labelEvery === 0 ? (index === 0 || (date.getMonth() !== first && date.getDate() <= labelEvery) ? dayLabel(day.start) : String(date.getDate())) : undefined;
          return (
            <li key={day.start} className="usage-chart-day" tabIndex={0} aria-label={summary} {...tooltipProps(summary, { side: "top" })}>
              <span className="usage-chart-stack">
                {plan > 0 ? <span className="usage-bar" data-part="plan" style={{ height: share(plan) }} /> : null}
                {api > 0 ? <span className="usage-bar" data-part="api" style={{ height: share(api) }} /> : null}
              </span>
              {label ? <small className="usage-chart-date">{label}</small> : null}
            </li>
          );
        })}
      </ol>
      <details className="usage-table-view">
        <summary>Show as a table</summary>
        <table className="inspector-table usage-day-table">
          <thead><tr><th>Day</th><th className="usage-number">API spend</th><th className="usage-number">Plan value</th><th className="usage-number">Tokens</th><th className="usage-number">Turns</th></tr></thead>
          <tbody>
            {[...series].reverse().map((day) => (
              <tr key={day.start}>
                <td>{dayLabel(day.start, true)}</td>
                <td className="usage-number">{day.costUsd > 0 ? money(day.costUsd) : "—"}</td>
                <td className="usage-number">{day.apiValueUsd > 0 ? `≈ ${money(day.apiValueUsd)}` : "—"}</td>
                <td className="usage-number">{formatTokens(day.totalTokens)}</td>
                <td className="usage-number">{day.requests}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
