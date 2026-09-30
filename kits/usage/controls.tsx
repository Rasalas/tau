import { useState, useSyncExternalStore, type ReactNode } from "react";
import { Monitor, Network, RefreshCw, Server, SlidersHorizontal } from "lucide-react";
import { formatCost, ProviderIconStack, Sheet, tooltipProps, usePreferences } from "tau";
import type { UsageFigures, UsageMetric, UsageOrigin, UsageRange } from "./dashboard.js";
import type { UsageFacts, UsageFilters, UsageView } from "./filters.js";
import type { UsageMachine } from "./machines.js";
import type { MonthFigures } from "./month.js";
import { BACKEND_USAGE_SOURCES, PI_BACKEND } from "./protocol.js";
import { formatTokens } from "./view-model.js";

export const RUNTIME_LABELS: Record<string, string> = Object.fromEntries([[PI_BACKEND, "Pi"], ...BACKEND_USAGE_SOURCES.map((source) => [source.backend, source.label])]);
const METRICS: ReadonlyArray<{ id: UsageMetric; label: string }> = [{ id: "cost", label: "Cost" }, { id: "tokens", label: "Tokens" }, { id: "turns", label: "Turns" }];
const ORIGINS: ReadonlyArray<{ id: UsageOrigin | "all"; label: string }> = [{ id: "all", label: "All" }, { id: "tau", label: "In Tau" }, { id: "outside", label: "Outside Tau" }];

/** The periods, the month by its name: "October", "Oct" where room is short. */
export function usageRanges(now: Date = new Date()): ReadonlyArray<{ id: UsageRange; label: string; short: string }> {
  return [
    { id: "month", label: now.toLocaleString(undefined, { month: "long" }), short: now.toLocaleString(undefined, { month: "short" }) },
    { id: "30d", label: "30 days", short: "30d" },
    { id: "all", label: "All time", short: "All" },
  ];
}

/** Design 1h's period at the right of the page head; a phone shows the first two, short. */
export function PeriodSwitch({ view, now }: { view: UsageView; now?: Date | undefined }) {
  const { filters } = useView(view);
  return (
    <div className="usage-period" role="radiogroup" aria-label="Period">
      {usageRanges(now).map((range) => (
        <button key={range.id} type="button" role="radio" aria-checked={filters.range === range.id} aria-label={range.label} data-range={range.id} onClick={() => view.setFilters({ range: range.id })}>
          <span className="long">{range.label}</span><span className="short" aria-hidden="true">{range.short}</span>
        </button>
      ))}
    </div>
  );
}

export function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: ReadonlyArray<{ id: T; label: string }>; onChange(value: T): void }) {
  return (
    <div className="segmented usage-segmented" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button key={option.id} type="button" role="radio" aria-checked={value === option.id} className={value === option.id ? "active" : ""} onClick={() => onChange(option.id)}>{option.label}</button>
      ))}
    </div>
  );
}

/** All runtimes, or one: the runtimes as marks, their names on hover. */
function RuntimeFilter({ runtimes, value, onChange }: { runtimes: readonly string[]; value: string | undefined; onChange(value: string | undefined): void }) {
  return (
    <div className="segmented usage-segmented usage-runtimes" role="radiogroup" aria-label="Runtime">
      <button type="button" role="radio" aria-checked={value === undefined} className={value === undefined ? "active" : ""} onClick={() => onChange(undefined)}>All</button>
      {runtimes.map((runtime) => {
        const name = RUNTIME_LABELS[runtime] ?? runtime;
        return (
          <button key={runtime} type="button" role="radio" aria-checked={value === runtime} aria-label={name} className={value === runtime ? "active" : ""} onClick={() => onChange(runtime)} {...tooltipProps(name, { side: "top" })}>
            <ProviderIconStack runtimeProvider={runtime} hint={false} />
          </button>
        );
      })}
    </div>
  );
}

function machineOptions(machines: readonly UsageMachine[]): Array<{ id: string | undefined; label: string }> {
  return [{ id: undefined, label: "All machines" }, { id: "", label: "This computer" }, ...machines.map((machine) => ({ id: machine.id, label: machine.name }))];
}

/** Every machine, this one (`""`), or another by its host id. */
function MachineFilter({ machines, value, onChange }: { machines: readonly UsageMachine[]; value: string | undefined; onChange(value: string | undefined): void }) {
  return (
    <div className="segmented usage-segmented" role="radiogroup" aria-label="Machine">
      {machineOptions(machines).map((option) => (
        <button key={option.id ?? "all"} type="button" role="radio" aria-checked={value === option.id} className={value === option.id ? "active" : ""} onClick={() => onChange(option.id)}>{option.label}</button>
      ))}
    </div>
  );
}

const noSubscription = () => () => {};

/** How the month reads: billed money first, else a plan's value, else tokens; costs hidden, tokens. */
function monthMeasure(figures: UsageFigures, showCosts: boolean): { pick(figures: UsageFigures): number; format(value: number): string; unit: string } {
  if (showCosts && figures.costUsd > 0) return { pick: (entry) => entry.costUsd, format: (value) => formatCost(value) ?? "$0", unit: "billed" };
  if (showCosts && figures.apiValueUsd > 0) return { pick: (entry) => entry.apiValueUsd, format: (value) => `≈ ${formatCost(value) ?? "$0"}`, unit: "plan value" };
  return { pick: (entry) => entry.totalTokens, format: formatTokens, unit: "tokens" };
}

/** This month so far, large; the month before up to the same day, and where this one is headed. */
export function MonthFigure({ month }: { month: MonthFigures | undefined }) {
  let preferences: ReturnType<typeof usePreferences> | undefined;
  try { preferences = usePreferences(); } catch { preferences = undefined; }
  const showCosts = useSyncExternalStore(preferences?.subscribe ?? noSubscription, () => preferences?.getSnapshot().showCosts ?? true);
  if (!month) return <section className="usage-month" aria-label="This month"><h2>This month</h2><p className="usage-month-figure" data-empty="true"><b>—</b></p></section>;
  const { current, previous, projected } = month;
  const measure = monthMeasure(current, showCosts);
  const value = measure.pick(current);
  const plan = showCosts && measure.unit === "billed" ? formatCost(current.apiValueUsd) : undefined;
  const before = previous ? measure.pick(previous.figures) : 0;
  const change = before > 0 ? Math.round(((value - before) / before) * 100) : undefined;
  return (
    <section className="usage-month" aria-label="This month">
      <h2>{month.name}</h2>
      <p className="usage-month-figure" data-empty={value > 0 ? undefined : "true"}><b>{measure.format(value)}</b><small>{measure.unit}</small></p>
      {plan ? <p className="usage-month-line">≈ {plan} plan value</p> : null}
      <p className="usage-month-line">{measure.unit === "tokens" ? "" : `${formatTokens(current.totalTokens)} tokens · `}{current.requests} {current.requests === 1 ? "turn" : "turns"} · {current.threads} {current.threads === 1 ? "thread" : "threads"}</p>
      {previous && before > 0 ? (
        <p className="usage-month-line" {...tooltipProps(`${previous.name} up to the same day: ${measure.format(before)}`, { side: "right" })}>
          {change === undefined || change === 0 ? "Same as" : <><span className="usage-month-change">{change > 0 ? `+${change}%` : `${change}%`}</span> on</>} {previous.name} by this day
        </p>
      ) : null}
      {projected ? <p className="usage-month-line">On pace for {measure.format(measure.pick(projected))}</p> : null}
    </section>
  );
}

function NavGroup({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <div className="settings-nav-group" role="radiogroup" aria-label={heading}>
      <h2 className="settings-nav-heading">{heading}</h2>
      {children}
    </div>
  );
}

function NavRow({ active, icon, label, onSelect }: { active: boolean; icon?: ReactNode; label: string; onSelect(): void }) {
  return (
    <button type="button" role="radio" aria-checked={active} aria-label={label} className={active ? "active" : undefined} onClick={onSelect}>
      {icon}<span>{label}</span>
    </button>
  );
}

const SECTIONS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "usage-limits", label: "Limits" }, { id: "usage-activity", label: "Activity" }, { id: "usage-projects", label: "Projects" }, { id: "usage-models", label: "Models" },
];

/** Scrolls the page to one of its sections. */
export function jumpTo(id: string, behavior: ScrollBehavior = "smooth"): void {
  document.getElementById(id)?.scrollIntoView({ block: "start", behavior });
}

function useView(view: UsageView): { filters: UsageFilters; facts: UsageFacts } {
  const filters = useSyncExternalStore(view.subscribe, view.getFilters);
  const facts = useSyncExternalStore(view.subscribe, view.getFacts);
  return { filters, facts };
}

/**
 * The page's sidebar, from the top: this month's figure, the filters of the
 * Activity section in Settings' rows, and quiet links to the sections.
 */
export function UsageSidebar({ view }: { view: UsageView }) {
  const { filters, facts } = useView(view);
  return (
    <div className="settings-nav-list usage-sidebar">
      <MonthFigure month={facts.month} />
      {facts.machines.length > 0 ? (
        <NavGroup heading="Machine">
          {machineOptions(facts.machines).map((option) => (
            <NavRow key={option.id ?? "all"} active={filters.machine === option.id} icon={option.id === undefined ? <Network size={14} aria-hidden="true" /> : option.id === "" ? <Monitor size={14} aria-hidden="true" /> : <Server size={14} aria-hidden="true" />} label={option.label} onSelect={() => view.setFilters({ machine: option.id })} />
          ))}
        </NavGroup>
      ) : null}
      {facts.anyOutside ? (
        <div className="settings-nav-group usage-sidebar-segment">
          <h2 className="settings-nav-heading">Where it ran</h2>
          <Segmented<UsageOrigin | "all"> label="Where the work ran" value={filters.origin ?? "all"} options={ORIGINS} onChange={(value) => view.setFilters({ origin: value === "all" ? undefined : value })} />
        </div>
      ) : null}
      {facts.runtimes.length > 1 ? (
        <NavGroup heading="Runtime">
          <NavRow active={filters.runtime === undefined} label="All runtimes" onSelect={() => view.setFilters({ runtime: undefined })} />
          {facts.runtimes.map((runtime) => (
            <NavRow key={runtime} active={filters.runtime === runtime} icon={<ProviderIconStack runtimeProvider={runtime} hint={false} />} label={RUNTIME_LABELS[runtime] ?? runtime} onSelect={() => view.setFilters({ runtime })} />
          ))}
        </NavGroup>
      ) : null}
      <div className="settings-nav-group usage-sidebar-segment">
        <h2 className="settings-nav-heading">Measure</h2>
        <Segmented<UsageMetric> label="Measure" value={filters.metric} options={METRICS} onChange={(metric) => view.setFilters({ metric })} />
      </div>
      <nav className="usage-jumps" aria-label="Sections">
        {SECTIONS.map((section) => <a key={section.id} href={`#${section.id}`} onClick={(event) => { event.preventDefault(); jumpTo(section.id); }}>{section.label}</a>)}
      </nav>
    </div>
  );
}

function SheetGroup({ label, children }: { label: string; children: ReactNode }) {
  return <div className="usage-sheet-group"><h3>{label}</h3>{children}</div>;
}

/**
 * Without the sidebar (a phone, a tablet): a Filters button beside the period
 * opens the month, every filter and the read in a sheet (design 1r).
 */
export function UsageFilterButton({ view, now, status, busy, onReadAgain }: { view: UsageView; now?: Date | undefined; status: string; busy: boolean; onReadAgain(): void }) {
  const { filters, facts } = useView(view);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="usage-icon-button" aria-label="Filters" aria-haspopup="dialog" onClick={() => setOpen(true)} {...tooltipProps("Filters", { side: "bottom" })}><SlidersHorizontal size={16} /></button>
      {open ? (
        <Sheet title="Usage filters" className="usage-sheet" onClose={() => setOpen(false)}>
          <MonthFigure month={facts.month} />
          <SheetGroup label="Period"><Segmented<UsageRange> label="Range" value={filters.range} options={usageRanges(now)} onChange={(range) => view.setFilters({ range })} /></SheetGroup>
          {facts.machines.length > 0 ? <SheetGroup label="Machine"><MachineFilter machines={facts.machines} value={filters.machine} onChange={(machine) => view.setFilters({ machine })} /></SheetGroup> : null}
          {facts.anyOutside ? <SheetGroup label="Where it ran"><Segmented<UsageOrigin | "all"> label="Where the work ran" value={filters.origin ?? "all"} options={ORIGINS} onChange={(value) => view.setFilters({ origin: value === "all" ? undefined : value })} /></SheetGroup> : null}
          {facts.runtimes.length > 1 ? <SheetGroup label="Runtime"><RuntimeFilter runtimes={facts.runtimes} value={filters.runtime} onChange={(runtime) => view.setFilters({ runtime })} /></SheetGroup> : null}
          <SheetGroup label="Measure"><Segmented<UsageMetric> label="Measure" value={filters.metric} options={METRICS} onChange={(metric) => view.setFilters({ metric })} /></SheetGroup>
          <p className="usage-sheet-read"><span>{status}</span><button type="button" className="mini-button" disabled={busy} onClick={onReadAgain}><RefreshCw size={13} />Read again</button></p>
        </Sheet>
      ) : null}
    </>
  );
}
