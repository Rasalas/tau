import { formatCost, tooltipProps } from "tau";
import { measure, niceCeiling, type DayFigures, type UsageMetric } from "./dashboard.js";
import { formatTokens } from "./view-model.js";

const money = (value: number) => formatCost(value) ?? "$0";

function dayLabel(start: number, long = false): string {
  return new Date(start).toLocaleDateString(undefined, long ? { weekday: "short", day: "numeric", month: "short" } : { day: "numeric", month: "short" });
}

function tick(value: number, metric: UsageMetric): string {
  if (metric === "tokens") return formatTokens(value);
  return value >= 10 || value === 0 ? `$${Math.round(value)}` : `$${value.toFixed(value < 1 ? 2 : 1)}`;
}

/** What a day's bar says on hover, on focus and in the table. */
export function daySummary(day: DayFigures): string {
  const parts = [dayLabel(day.start, true)];
  const billed = formatCost(day.costUsd);
  const plan = formatCost(day.apiValueUsd);
  if (billed) parts.push(`${billed} billed`);
  if (plan) parts.push(`≈ ${plan} plan value`);
  parts.push(`${formatTokens(day.totalTokens)} tokens`, `${day.requests} ${day.requests === 1 ? "turn" : "turns"}`);
  return parts.join(" · ");
}

/**
 * Columns per day. In money, the billed part sits on the baseline and a
 * plan's value above it in a lighter step of the same hue: two parts of one
 * bar, never one figure. In tokens, one column.
 */
export function UsageHistory({ series, metric }: { series: readonly DayFigures[]; metric: UsageMetric }) {
  const top = niceCeiling(Math.max(0, ...series.map((day) => measure(day, metric))));
  const share = (value: number) => `${Math.max(0, Math.min(100, (value / top) * 100))}%`;
  const labelEvery = series.length > 31 ? 14 : series.length > 8 ? 7 : 1;
  return (
    <figure className="usage-history" data-metric={metric}>
      <div className="usage-chart">
        <div className="usage-chart-ticks" aria-hidden="true">
          {[top, top / 2, 0].map((value) => <span key={value}>{tick(value, metric)}</span>)}
        </div>
        <div className="usage-chart-plot">
          <div className="usage-chart-grid" aria-hidden="true"><i /><i /><i /></div>
          <ol className="usage-chart-bars" aria-label={metric === "tokens" ? "Tokens per day" : "Cost per day"}>
            {series.map((day, index) => {
              const summary = daySummary(day);
              return (
                <li key={day.start} className="usage-chart-day" tabIndex={0} aria-label={summary} {...tooltipProps(summary, { side: "top" })}>
                  {metric === "tokens" ? (
                    day.totalTokens > 0 ? <span className="usage-bar tokens" style={{ height: share(day.totalTokens) }} /> : null
                  ) : (
                    <>
                      {day.costUsd > 0 ? <span className="usage-bar billed" style={{ height: share(day.costUsd) }} /> : null}
                      {day.apiValueUsd > 0 ? <span className="usage-bar plan" style={{ height: share(day.apiValueUsd) }} /> : null}
                    </>
                  )}
                  {(series.length - 1 - index) % labelEvery === 0 ? <small className="usage-chart-date">{index === series.length - 1 ? "Today" : dayLabel(day.start)}</small> : null}
                </li>
              );
            })}
          </ol>
        </div>
      </div>
      {metric === "cost" ? (
        <figcaption className="usage-legend">
          <span><i className="billed" />Billed per token</span>
          <span><i className="plan" />Plan value, at API prices</span>
        </figcaption>
      ) : null}
      <details className="usage-table-view">
        <summary>Show as a table</summary>
        <table className="inspector-table usage-day-table">
          <thead><tr><th>Day</th><th className="usage-number">Billed</th><th className="usage-number">Plan value</th><th className="usage-number">Tokens</th><th className="usage-number">Turns</th></tr></thead>
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
