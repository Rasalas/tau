import { useState } from "react";
import { formatCost, ProviderIconStack, providerStackLabel, tooltipProps } from "tau";
import { providerForecasts, type ForecastWindow } from "./forecast.js";
import type { UsageEntry } from "./protocol.js";
import { formatTokens } from "./view-model.js";

const money = (value: number) => formatCost(value) ?? "$0.00";
const precise = (value: number) => `$${value.toFixed(2)}`;
function estimate(value: number, missing: number): string {
  return missing > 0 ? value > 0 ? `≥ ${money(value)}` : "Unknown" : `≈ ${money(value)}`;
}

/** Recent model mix, priced per token, rather than the cost of a subscription. */
export function UsageForecast({ entries, days, now }: { entries: readonly UsageEntry[]; days: readonly number[]; now: Date }) {
  const [window, setWindow] = useState<ForecastWindow>(7);
  const rows = providerForecasts(entries, days, now, window);
  return (
    <section className="usage-card usage-forecast" id="usage-forecast" aria-labelledby="usage-forecast-title">
      <div className="usage-forecast-head">
        <h2 id="usage-forecast-title">Monthly forecast</h2>
        <div className="usage-period" role="group" aria-label="Forecast average">
          {([7, 30] as const).map((count) => <button key={count} type="button" aria-pressed={window === count} onClick={() => setWindow(count)}><span>Last {count} days</span></button>)}
        </div>
      </div>
      <p className="usage-note">What a full month would cost at your recent pace and model mix, at per-token API prices. Not a bill or a subscription fee.</p>
      {rows.length === 0 ? <p className="usage-note">No usage in this month or the averaging period.</p> : (
        <div className="usage-forecast-scroll">
          <table>
            <thead><tr><th scope="col">Provider</th><th scope="col">This month so far</th><th scope="col">API / day</th><th scope="col">API / month</th></tr></thead>
            <tbody>{rows.map((row) => <tr key={row.provider}>
              <th scope="row"><span className="usage-forecast-provider"><ProviderIconStack modelProvider={row.provider} hint={false} />{providerStackLabel(row.provider, undefined)}</span>
                {row.unknownTokens > 0 ? <small>{formatTokens(row.unknownTokens)} tok without a price in the average</small> : null}
              </th>
              <td><span {...tooltipProps(`API equivalent: ${precise(row.monthValueUsd)}${row.monthUnknownTokens > 0 ? " plus unpriced usage" : ""}`, { side: "top" })}>{estimate(row.monthValueUsd, row.monthUnknownTokens)}</span>
                <small {...tooltipProps(`Recorded API spend: ${precise(row.monthBilledUsd)}`, { side: "top" })}>{money(row.monthBilledUsd)} API spend</small>
                {row.monthUnknownTokens > 0 ? <small>{formatTokens(row.monthUnknownTokens)} tok unpriced</small> : null}
              </td>
              <td {...tooltipProps(`API equivalent: ${precise(row.dailyValueUsd)} per calendar day${row.unknownTokens > 0 ? ", incomplete" : ""}`, { side: "top" })}>{estimate(row.dailyValueUsd, row.unknownTokens)}</td>
              <td className="usage-forecast-total" {...tooltipProps(`API equivalent: ${precise(row.monthlyValueUsd)} for a full month${row.unknownTokens > 0 ? ", incomplete" : ""}`, { side: "top" })}>{estimate(row.monthlyValueUsd, row.unknownTokens)}</td>
            </tr>)}</tbody>
          </table>
        </div>
      )}
      <p className="usage-note">Average of the last {window} completed calendar days, including idle days; today is excluded. Daily average × {new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()} days in this month. USD. Runtime, machine and origin filters apply.</p>
      <p className="usage-note">Recorded token prices are used where available; free and local usage use known API prices or your model-price overrides. Missing prices make the estimate incomplete, marked ≥ or Unknown. Token totals dated only by a thread&apos;s last activity can skew the daily average.</p>
    </section>
  );
}
