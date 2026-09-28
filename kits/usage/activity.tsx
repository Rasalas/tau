import { useMemo, useState } from "react";
import { formatCost, tooltipProps } from "tau";
import type { UsageEntry, UsageLimitsSummary } from "./protocol.js";
import { providerOf, providerTone } from "./quota.js";
import { formatTokens } from "./view-model.js";

/** Calendar arithmetic rather than millisecond stepping, including daylight-saving days. */
export function calendarDays(now: Date, count: number): string[] {
  return Array.from({ length: count }, (_, index) => {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - count + 1 + index);
    return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
  });
}
const dateOf = (day: string) => new Date(`${day}T12:00:00`);
const dayLabel = (day: string) => dateOf(day).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const requests = (rows: readonly UsageEntry[]) => rows.reduce((total, row) => total + row.requests, 0);

type Metric = "requests" | "totalTokens" | "costUsd" | "apiValueUsd";
const METRICS: { id: Metric; label: string }[] = [{ id: "requests", label: "Responses" }, { id: "totalTokens", label: "Tokens" }, { id: "costUsd", label: "API billed" }, { id: "apiValueUsd", label: "Plan value" }];
const metricValue = (value: number, metric: Metric) => metric === "requests" ? `${value} responses` : metric === "totalTokens" ? `${formatTokens(value)} tokens` : formatCost(value) ?? "$0.00";

export function UsageActivity({ entries, labels, loaded, error, rangeDays, now }: { entries: readonly UsageEntry[]; labels: Record<string, string>; loaded: boolean; error?: string; rangeDays: number; now: number }) {
  const [source, setSource] = useState("all");
  const [metric, setMetric] = useState<Metric>("requests");
  const [selected, setSelected] = useState<string>();
  const dates = useMemo(() => calendarDays(new Date(now), 90), [now]);
  const sources = useMemo(() => [...new Set(entries.map((row) => row.backend))].map((backend) => [backend, labels[backend] ?? backend] as const), [entries, labels]);
  const byDay = useMemo(() => {
    const days = new Map<string, UsageEntry[]>();
    for (const row of entries) {
      const day = dates[row.day];
      if (!day || (source !== "all" && row.backend !== source)) continue;
      const values = days.get(day) ?? []; values.push(row); days.set(day, values);
    }
    return days;
  }, [entries, source, dates]);
  const maximum = Math.max(1, ...dates.map((date) => requests(byDay.get(date) ?? [])));
  const detail = (date: string) => {
    const rows = byDay.get(date) ?? [];
    const breakdown = [...new Set(rows.map((row) => row.backend))].map((backend) => {
      const values = rows.filter((row) => row.backend === backend);
      return `${labels[backend] ?? backend}: ${requests(values)}`;
    }).join(" · ");
    return `${dayLabel(date)}: ${requests(rows)} responses${breakdown ? ` · ${breakdown}` : " · no recorded activity"}`;
  };
  const firstDay = (dateOf(dates[0]!).getDay() + 6) % 7;
  const chartDates = dates.slice(-rangeDays);
  const chartMax = Math.max(1, ...chartDates.map((date) => (byDay.get(date) ?? []).reduce((total, row) => total + row[metric], 0)));
  const active = dates.filter((day) => requests(byDay.get(day) ?? []) > 0).length;

  return <section className="usage-activity" aria-label="Activity">
    <div className="usage-section-heading"><div><h4>Your activity</h4><p>Recorded responses across your Tau threads.</p></div>
      <div className="usage-source-filter" role="group" aria-label="Activity runtime">
        {[["all", "All runtimes"], ...sources].map(([id, label]) => <button type="button" key={id} aria-pressed={source === id} onClick={() => setSource(id!)}>{label}</button>)}
      </div>
    </div>
    {error ? <p className="settings-note" data-level="error">{error}</p> : null}
    {!loaded ? <p className="settings-note">Reading activity…</p> : <>
      <div className="usage-chart-card">
        <header><div><h4>Activity calendar</h4><span>Last 90 days</span></div><span>{active} active {active === 1 ? "day" : "days"}</span></header>
        <div className="usage-calendar-months" aria-hidden="true" style={{ gridTemplateColumns: `repeat(${Math.ceil((dates.length + firstDay) / 7)}, minmax(0, 1fr))` }}>
          {Array.from({ length: Math.ceil((dates.length + firstDay) / 7) }, (_, week) => {
            const date = dateOf(dates[Math.max(0, week * 7 - firstDay)]!);
            return <span key={week}>{week === 0 || date.getDate() <= 7 ? date.toLocaleDateString(undefined, { month: "short" }) : ""}</span>;
          })}
        </div>
        <div className="usage-calendar-layout">
          <div className="usage-weekdays" aria-hidden="true"><span>Mon</span><span>Wed</span><span>Fri</span></div>
          <div className="usage-calendar" style={{ gridTemplateColumns: `repeat(${Math.ceil((dates.length + firstDay) / 7)}, minmax(0, 1fr))` }}>
            {Array.from({ length: firstDay }, (_, i) => <span key={`pad-${i}`} />)}
            {dates.map((date) => {
              const count = requests(byDay.get(date) ?? []);
              const level = count ? Math.max(1, Math.ceil(4 * Math.log1p(count) / Math.log1p(maximum))) : 0;
              return <button key={date} type="button" data-level={level} aria-label={detail(date)} aria-pressed={selected === date} {...tooltipProps(detail(date))} onClick={() => setSelected(date)} />;
            })}
          </div>
        </div>
        <footer><span aria-live="polite">{selected ? detail(selected) : "Select a day to see its breakdown."}</span><span className="usage-calendar-key" aria-hidden="true">Less {[0, 1, 2, 3, 4].map((level) => <i key={level} data-level={level} />)} More</span></footer>
      </div>
      <div className="usage-chart-card">
        <header><div><h4>Day by day</h4><span>{chartDates[0] ? `${dayLabel(chartDates[0])} – ${dayLabel(chartDates.at(-1)!)}` : "No days in this period"}</span></div>
          <div className="segmented" role="group" aria-label="Activity metric">{METRICS.map((entry) => <button type="button" key={entry.id} className={metric === entry.id ? "active" : ""} aria-pressed={metric === entry.id} onClick={() => setMetric(entry.id)}>{entry.label}</button>)}</div>
        </header>
        <div className="usage-daily-chart" role="group" aria-label="Daily activity">
          <span className="usage-chart-ceiling">{metricValue(chartMax, metric)}</span>
          <div className="usage-daily-bars">{chartDates.map((date) => {
            const rows = byDay.get(date) ?? [];
            const total = rows.reduce((sum, row) => sum + row[metric], 0);
            const label = `${dayLabel(date)}: ${metricValue(total, metric)}`;
            return <button type="button" className="usage-day-column" key={date} aria-label={label} {...tooltipProps(label)} onClick={() => setSelected(date)} aria-pressed={selected === date}>
              <span className="usage-day-stack" style={{ height: `${100 * total / chartMax}%` }}>{sources.map(([id]) => {
                const value = rows.filter((row) => row.backend === id).reduce((sum, row) => sum + row[metric], 0);
                return value > 0 ? <span key={id} data-provider={providerTone(id)} style={{ height: `${100 * value / total}%` }} /> : null;
              })}</span>
            </button>;
          })}</div>
        </div>
        <div className="usage-chart-axis"><span>{chartDates[0] && dayLabel(chartDates[0])}</span><span>{chartDates.at(-1) && dayLabel(chartDates.at(-1)!)}</span></div>
        <div className="usage-chart-legend">{sources.filter(([id]) => source === "all" || source === id).map(([id, label]) => <span key={id} data-provider={providerTone(id)}><i aria-hidden="true" />{label}</span>)}</div>
        {active === 0 ? <p className="settings-note">No recorded activity for this selection.</p> : null}
        <p className="usage-chart-note">{metric === "apiValueUsd" ? "What subscription tokens would have cost via the API, not a subscription bill. Unpriced usage is excluded." : metric === "costUsd" ? "Per-token costs reported by runtimes or calculated from your model prices. Subscription value is kept separate." : "Tokens include cache. Older threads without dated turns are counted on their last activity date."} </p>
      </div>
    </>}
  </section>;
}

/** Step charts never join separate resets or gaps longer than ten minutes. */
export function QuotaHistory({ limits, now }: { limits?: UsageLimitsSummary; now: number }) {
  const series = new Map<string, { label: string; provider: string; points: { at: number; value: number; reset?: number }[] }>();
  for (const { source, account } of limits?.history ?? []) {
    if (account.checkedAt < now - 86_400_000 || account.checkedAt > now) continue;
    for (const window of account.windows) {
      const key = `${source}:${account.runtime}:${account.id}:${window.id}`;
      let entry = series.get(key);
      if (!entry) { entry = { label: `${account.label} · ${window.label}`, provider: providerTone(providerOf(account)), points: [] }; series.set(key, entry); }
      entry.points.push({ at: account.checkedAt, value: window.usedPercent, reset: window.resetsAt });
    }
  }
  return <details className="usage-disclosure usage-quota-history"><summary>Quota history <span>Last 24 hours</span></summary>
    <p className="usage-chart-note">Provider readings collected when Usage is open, retained for 24 hours. Token counts cannot reconstruct subscription percentages. Gaps mean there was no fresh reading.</p>
    {series.size === 0 ? <p className="settings-note">Further readings will build the history here.</p> : <div className="usage-history-grid">{[...series].map(([key, entry]) => {
      entry.points.sort((a, b) => a.at - b.at);
      const x = (at: number) => 4 + 592 * (at - (now - 86_400_000)) / 86_400_000;
      const y = (value: number) => 96 - value * .88;
      let path = "";
      entry.points.forEach((point, i) => {
        const previous = entry.points[i - 1];
        path += !previous || point.reset !== previous.reset || point.at - previous.at > 600_000 || point.value < previous.value
          ? ` M ${x(point.at)} ${y(point.value)}` : ` H ${x(point.at)} V ${y(point.value)}`;
      });
      return <div className="usage-history-series" key={key} data-provider={entry.provider}><h5>{entry.label}</h5>
        <svg viewBox="0 0 600 104" role="img" aria-label={`${entry.label}, ${entry.points.length} readings in the last 24 hours`}>
          <path d="M 4 8 H 596 M 4 52 H 596 M 4 96 H 596" className="usage-chart-grid" />
          <path d={path} className="usage-history-line" />
          {entry.points.map((point, i) => <circle key={i} cx={x(point.at)} cy={y(point.value)} r="2"><title>{new Date(point.at).toLocaleTimeString()}: {Math.round(point.value)}% used</title></circle>)}
        </svg><div className="usage-chart-axis"><span>24h ago</span><span>Now</span></div>
      </div>;
    })}</div>}
  </details>;
}
