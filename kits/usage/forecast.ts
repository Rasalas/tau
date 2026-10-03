import { providerOf } from "./dashboard.js";
import { monthStart } from "./month.js";
import type { UsageEntry } from "./protocol.js";

export type ForecastWindow = 7 | 30;

export interface ProviderForecast {
  provider: string;
  monthBilledUsd: number;
  monthValueUsd: number;
  monthUnknownTokens: number;
  dailyValueUsd: number;
  monthlyValueUsd: number;
  unknownTokens: number;
}

/** A recorded price, or an explicit hypothetical API price; unknown is not zero. */
function apiValue(entry: UsageEntry): number | undefined {
  if (entry.apiEquivalentUsd !== undefined) return entry.apiEquivalentUsd;
  const value = entry.costUsd + entry.apiValueUsd;
  return value > 0 || (entry.priceSource && entry.priceSource !== "none") ? value : undefined;
}

/**
 * Same model mix at the recent daily pace, scaled to this month's calendar
 * length. Only completed calendar days enter the average; idle days count.
 * Month-to-date includes today. The page's runtime/machine/origin filters
 * have already been applied, its chart's period and metric do not apply.
 */
export function providerForecasts(entries: readonly UsageEntry[], days: readonly number[], now: Date, window: ForecastWindow): ProviderForecast[] {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - window).getTime();
  const month = monthStart(now);
  const length = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const rows = new Map<string, ProviderForecast>();
  for (const entry of entries) {
    const day = days[entry.day];
    if (day === undefined || day > today || day < Math.min(month, start)) continue;
    const provider = providerOf(entry);
    let row = rows.get(provider);
    if (!row) {
      row = { provider, monthBilledUsd: 0, monthValueUsd: 0, monthUnknownTokens: 0, dailyValueUsd: 0, monthlyValueUsd: 0, unknownTokens: 0 };
      rows.set(provider, row);
    }
    const value = apiValue(entry);
    if (day >= month) {
      row.monthBilledUsd += entry.costUsd;
      if (value === undefined) row.monthUnknownTokens += entry.totalTokens;
      else row.monthValueUsd += value;
    }
    if (day >= start && day < today) {
      if (value === undefined) row.unknownTokens += entry.totalTokens;
      else row.dailyValueUsd += value / window;
    }
  }
  for (const row of rows.values()) row.monthlyValueUsd = row.dailyValueUsd * length;
  return [...rows.values()].sort((left, right) => right.monthlyValueUsd - left.monthlyValueUsd || left.provider.localeCompare(right.provider));
}
