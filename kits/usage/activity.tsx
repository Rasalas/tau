import type { CSSProperties } from "react";
import { tooltipProps } from "tau";
import type { UsageEntry, UsageLimitsSummary } from "./protocol.js";
import { toneOf, type UsageTone } from "./tones.js";
import { toneOfEntry } from "./dashboard.js";

const DAY_MS = 86_400_000;
const toned = (name: string | undefined): CSSProperties => ({ "--usage-tone": `var(--provider-${toneOf(name)})` }) as CSSProperties;
const WEEKDAYS = ["Mon", "", "Wed", "", "Fri", "", ""];

function dayLabel(start: number): string {
  return new Date(start).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

/** 0 for no turns, else 1–4 on a log scale against the busiest day. */
export function activityLevel(turns: number, busiest: number): number {
  if (turns <= 0) return 0;
  return Math.max(1, Math.min(4, Math.ceil((4 * Math.log1p(turns)) / Math.log1p(Math.max(1, busiest)))));
}

/**
 * The days as a calendar: a column per week, Monday on top, the shade by
 * turns and the colour by the provider that answered most that day. It shows the
 * rhythm; the chart beside it the amounts. A cell names
 * its day on hover; the table under the chart has every day for touch and
 * screen readers.
 */
export function ActivityCalendar({ days, entries, labels }: { days: readonly number[]; entries: readonly UsageEntry[]; labels: Record<string, string> }) {
  const perDay = days.map(() => new Map<string, number>());
  const tones = days.map(() => new Map<UsageTone, number>());
  for (const entry of entries) {
    const day = perDay[entry.day];
    if (!day) continue;
    day.set(entry.backend, (day.get(entry.backend) ?? 0) + entry.requests);
    const tone = toneOfEntry(entry);
    tones[entry.day]!.set(tone, (tones[entry.day]!.get(tone) ?? 0) + entry.requests);
  }
  const totals = perDay.map((day) => [...day.values()].reduce((sum, value) => sum + value, 0));
  const busiest = Math.max(0, ...totals);
  const active = totals.filter((turns) => turns > 0).length;
  const lead = days.length > 0 ? (new Date(days[0]!).getDay() + 6) % 7 : 0;
  const weeks = Math.ceil((lead + days.length) / 7);
  const months = Array.from({ length: weeks }, (_, week) => {
    const first = days[Math.max(0, week * 7 - lead)];
    const previous = week > 0 ? days[Math.max(0, (week - 1) * 7 - lead)] : undefined;
    if (first === undefined) return "";
    const month = new Date(first).getMonth();
    return previous === undefined || new Date(previous).getMonth() !== month ? new Date(first).toLocaleDateString(undefined, { month: "short" }) : "";
  });
  const hint = (index: number) => {
    const turns = totals[index]!;
    if (!turns) return `${dayLabel(days[index]!)}: nothing recorded`;
    const parts = [...perDay[index]!].sort((left, right) => right[1] - left[1]).map(([backend, count]) => `${labels[backend] ?? backend} ${count}`);
    return `${dayLabel(days[index]!)}: ${turns} ${turns === 1 ? "turn" : "turns"}${parts.length > 1 ? ` (${parts.join(", ")})` : ""}`;
  };
  return (
    <figure className="usage-calendar">
      <figcaption>
        <span>Last {days.length} days</span>
        <b>{active} active {active === 1 ? "day" : "days"}</b>
      </figcaption>
      <div className="usage-calendar-grid" role="img" aria-label={`${active} of the last ${days.length} days with turns`} style={{ gridTemplateColumns: `auto repeat(${weeks}, var(--usage-cell))` }}>
        <span className="usage-calendar-corner" />
        {months.map((month, week) => <span key={`m${week}`} className="usage-calendar-month" style={{ gridColumn: week + 2, gridRow: 1 }}>{month}</span>)}
        {WEEKDAYS.map((name, row) => <span key={`w${row}`} className="usage-calendar-weekday" style={{ gridColumn: 1, gridRow: row + 2 }}>{name}</span>)}
        {days.map((start, index) => {
          const slot = lead + index;
          const main = [...tones[index]!].sort((left, right) => right[1] - left[1])[0]?.[0] ?? "other";
          return (
            <i
              key={start}
              data-level={activityLevel(totals[index]!, busiest)}
              style={{ "--usage-tone": `var(--provider-${main})`, gridColumn: Math.floor(slot / 7) + 2, gridRow: (slot % 7) + 2 } as CSSProperties}
              {...tooltipProps(hint(index), { side: "top" })}
            />
          );
        })}
      </div>
      <div className="usage-calendar-key" aria-hidden="true">Less{[0, 1, 2, 3, 4].map((level) => <i key={level} data-level={level} />)}More</div>
    </figure>
  );
}

/** Where a reading's point sits: 24 hours across, 0–100 % up. */
const X = (at: number, now: number) => 4 + (592 * (at - (now - DAY_MS))) / DAY_MS;
const Y = (value: number) => 96 - value * 0.88;

/**
 * Each window's readings of the last day as a step line. A reset, a drop or
 * a gap of more than ten minutes starts a new line: what happened in between
 * was not read.
 */
export function ReadingHistory({ limits, now }: { limits: UsageLimitsSummary | undefined; now: number }) {
  const series = new Map<string, { label: string; tone: CSSProperties; points: { at: number; value: number; reset?: number }[] }>();
  for (const { account } of limits?.history ?? []) {
    if (account.checkedAt < now - DAY_MS || account.checkedAt > now) continue;
    // One line per source: two runtimes read one account at different moments.
    for (const window of account.windows) {
      const key = `${account.machine ?? ""}\u0000${account.runtime}\u0000${account.id}\u0000${window.id}`;
      let entry = series.get(key);
      if (!entry) {
        entry = { label: `${account.label} · ${window.label}`, tone: toned(account.runtime === "pi" ? account.id.replace(/^pi:/u, "") : account.identity?.provider ?? account.runtime), points: [] };
        series.set(key, entry);
      }
      entry.points.push({ at: account.checkedAt, value: window.usedPercent, ...(window.resetsAt ? { reset: window.resetsAt } : {}) });
    }
  }
  const drawn = [...series].filter(([, entry]) => entry.points.length > 0);
  return (
    <details className="usage-readings">
      <summary>Readings of the last 24 hours</summary>
      {drawn.length === 0 ? <p className="usage-note">Each read of the limits adds a point here; none were kept yet.</p> : (
        <div className="usage-readings-grid">
          {drawn.map(([key, entry]) => {
            const points = [...entry.points].sort((left, right) => left.at - right.at);
            let path = "";
            points.forEach((point, index) => {
              const previous = points[index - 1];
              const jump = !previous || Math.abs((point.reset ?? 0) - (previous.reset ?? 0)) > 60_000 || point.at - previous.at > 600_000 || point.value < previous.value;
              path += jump ? ` M ${X(point.at, now).toFixed(1)} ${Y(point.value).toFixed(1)}` : ` H ${X(point.at, now).toFixed(1)} V ${Y(point.value).toFixed(1)}`;
            });
            return (
              <figure key={key} className="usage-readings-series" style={entry.tone}>
                <figcaption>{entry.label}</figcaption>
                <svg viewBox="0 0 600 104" role="img" aria-label={`${entry.label}: ${points.length} ${points.length === 1 ? "reading" : "readings"}, last ${Math.round(points.at(-1)!.value)}% used`}>
                  <path d="M 4 8 H 596 M 4 52 H 596 M 4 96 H 596" className="usage-readings-grid-lines" />
                  <path d={path.trim()} className="usage-readings-line" />
                  {points.map((point) => <circle key={point.at} cx={X(point.at, now).toFixed(1)} cy={Y(point.value).toFixed(1)} r="2.5" className="usage-readings-point" />)}
                </svg>
                <div className="usage-readings-axis"><span>24 h ago</span><span>Now</span></div>
              </figure>
            );
          })}
        </div>
      )}
    </details>
  );
}
