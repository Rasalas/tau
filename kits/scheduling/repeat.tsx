import { useId, useState } from "react";
import { ChevronRight } from "lucide-react";
import { cronFromRule, describeCron, nextRuns, parseCron, ruleFromCron, WEEK, type RepeatRule } from "./cron.js";

export const DEFAULT_REPEAT = "0 9 * * *";
export const localTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const pad = (value: number) => String(value).padStart(2, "0");

/** Why an expression cannot be saved, or undefined. */
export function repeatProblem(expression: string, timezone: string, now: number): string | undefined {
  try { return nextRuns(expression, timezone, now, 1).length ? undefined : "This never runs: no date matches in the next five years."; }
  catch (error) { return (error as Error).message; }
}

/** The values a frequency switch keeps: 09:00 stays 09:00 from day to week. */
interface Kept { minute: number; time: string; weekdays: number[]; day: number }
const keep = (kept: Kept, rule: RepeatRule | undefined): Kept => !rule ? kept
  : rule.frequency === "hour" ? { ...kept, minute: rule.minute }
  : { ...kept, time: rule.time, minute: Number(rule.time.slice(3)), ...(rule.frequency === "week" ? { weekdays: rule.weekdays } : rule.frequency === "month" ? { day: rule.day } : {}) };
const build = (frequency: RepeatRule["frequency"], kept: Kept): RepeatRule => frequency === "hour" ? { frequency, minute: kept.minute }
  : frequency === "week" ? { frequency, time: kept.time, weekdays: kept.weekdays }
  : frequency === "month" ? { frequency, time: kept.time, day: kept.day }
  : { frequency, time: kept.time };

/** "Fri 16 Oct" and "09:00" in the schedule's zone, for the preview line. */
function readable(at: number, timezone: string) {
  const parts: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat([], { timeZone: timezone, hourCycle: "h23", weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).formatToParts(at)) parts[part.type] = part.value;
  return { weekday: parts.weekday!, day: parts.day!, month: parts.month!, year: parts.year!, time: `${parts.hour}:${parts.minute}` };
}
/** "Next Fri 16 Oct, then Mon 19, Wed 21": dates as far as they differ, times when the rule does not fix them. */
export function previewRuns(runs: readonly number[], timezone: string, withTime: boolean, now: number): string {
  const today = readable(now, timezone);
  const words = runs.map((at, index) => {
    const value = readable(at, timezone), before = index ? readable(runs[index - 1]!, timezone) : undefined;
    const sameMonth = before?.month === value.month && before.year === value.year;
    const sameDay = sameMonth && before!.day === value.day;
    const date = sameDay ? "" : sameMonth ? `${value.weekday} ${value.day}` : `${value.weekday} ${value.day} ${value.month}${value.year === today.year ? "" : ` ${value.year}`}`;
    return [date, withTime || sameDay ? value.time : ""].filter(Boolean).join(" ");
  });
  return `Next ${words[0]}${words.length > 1 ? `, then ${words.slice(1).join(", ")}` : ""}`;
}

/**
 * Every [hour|day|week|month] at [09:00], the days, the next runs and the cron
 * expression behind them. The composer's Repeat tab and the Automations editor
 * share it. An expression the controls cannot show reads as Custom.
 */
export function RepeatBuilder({ expression, timezone, onChange, disabled, now = Date.now }: { expression: string; timezone: string; onChange(expression: string): void; disabled?: boolean; now?(): number }) {
  const rule = ruleFromCron(expression);
  const [kept, setKept] = useState<Kept>(() => keep({ minute: 0, time: "09:00", weekdays: [1, 2, 3, 4, 5], day: 1 }, rule));
  const [cronOpen, setCronOpen] = useState(!rule);
  const id = useId();
  const current = keep(kept, rule);
  const change = (frequency: RepeatRule["frequency"], patch: Partial<Kept> = {}) => {
    const next = { ...current, ...patch };
    setKept(next);
    onChange(cronFromRule(build(frequency, next)));
  };
  let runs: number[] = [], problem: string | undefined;
  try { runs = nextRuns(expression, timezone, now(), 3); if (!runs.length) problem = "This never runs: no date matches in the next five years."; }
  catch (error) { problem = (error as Error).message; }
  let source = expression.trim();
  try { source = parseCron(expression).source; } catch { /* the field shows the error */ }
  const foreign = timezone !== localTimeZone();
  const toggle = (day: number) => {
    if (rule?.frequency !== "week") return;
    const days = rule.weekdays.includes(day) ? rule.weekdays.filter((entry) => entry !== day) : [...rule.weekdays, day];
    // A week needs one day; the last one stays.
    if (days.length) change("week", { weekdays: days });
  };
  return <div className="scheduling-repeat">
    <div className="scheduling-repeat-row">
      {rule ? <span>Every</span> : null}
      <select aria-label="Repeat every" value={rule?.frequency ?? "custom"} disabled={disabled} onChange={(event) => change(event.target.value as RepeatRule["frequency"])}>
        <option value="hour">hour</option><option value="day">day</option><option value="week">week</option><option value="month">month</option>
        {rule ? null : <option value="custom">Custom</option>}
      </select>
      {!rule ? <span className="scheduling-repeat-custom">{describeCron(expression) ?? source}</span>
        : rule.frequency === "hour" ? <><span>at minute</span><select aria-label="Minute" value={rule.minute} disabled={disabled} onChange={(event) => change("hour", { minute: Number(event.target.value) })}>{Array.from({ length: 60 }, (_, minute) => <option key={minute} value={minute}>{pad(minute)}</option>)}</select></>
        : <><span>at</span><input type="time" aria-label="Time" required value={rule.time} disabled={disabled} onChange={(event) => { if (/^\d{2}:\d{2}$/u.test(event.target.value)) change(rule.frequency, { time: event.target.value, minute: Number(event.target.value.slice(3)) }); }} /></>}
    </div>
    {rule?.frequency === "week" ? <div className="scheduling-repeat-row"><span>on</span><div className="scheduling-repeat-days" role="group" aria-label="Days">
      {WEEK.map((day) => <button key={day} type="button" aria-pressed={rule.weekdays.includes(day)} aria-label={DAY_NAMES[day]} disabled={disabled} onClick={() => toggle(day)}>{DAY_NAMES[day]![0]}</button>)}
    </div></div> : null}
    {rule?.frequency === "month" ? <div className="scheduling-repeat-row"><span>on day</span><select aria-label="Day of month" value={rule.day} disabled={disabled} onChange={(event) => change("month", { day: Number(event.target.value) })}>{Array.from({ length: 31 }, (_, index) => <option key={index} value={index + 1}>{index + 1}</option>)}</select>{rule.day > 28 ? <small>Months without day {rule.day} are skipped.</small> : null}</div> : null}
    {runs.length ? <p className="scheduling-repeat-next">{previewRuns(runs, timezone, rule?.frequency === "hour" || !rule, now())}{foreign ? ` (${timezone})` : ""}</p> : null}
    <details className="scheduling-repeat-cron" open={cronOpen} onToggle={(event) => setCronOpen(event.currentTarget.open)}>
      <summary><ChevronRight size={14} aria-hidden="true" />Cron <code>{source}</code></summary>
      <input aria-label="Cron expression" spellCheck={false} autoComplete="off" maxLength={200} value={expression} disabled={disabled} aria-invalid={Boolean(problem)} aria-describedby={problem ? `${id}-problem` : undefined} onChange={(event) => onChange(event.target.value)} />
      <small>Minute, hour, day of month, month, day of week{foreign ? `, in ${timezone}` : ", in local time"}.</small>
    </details>
    {problem ? <p id={`${id}-problem`} role="alert" className="scheduling-error">{problem}</p> : null}
  </div>;
}
