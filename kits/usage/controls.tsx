import { useSyncExternalStore, type ReactNode } from "react";
import { Monitor, Server } from "lucide-react";
import { formatCost, ProviderIconStack, tooltipProps, usePreferences } from "tau";
import { USAGE_RANGES, type UsageFigures, type UsageMetric, type UsageOrigin, type UsageRange } from "./dashboard.js";
import type { UsageFacts, UsageFilters, UsageView } from "./filters.js";
import type { UsageMachine } from "./machines.js";
import type { MonthFigures } from "./month.js";
import { BACKEND_USAGE_SOURCES, PI_BACKEND } from "./protocol.js";
import { formatTokens } from "./view-model.js";

export const RUNTIME_LABELS: Record<string, string> = Object.fromEntries([[PI_BACKEND, "Pi"], ...BACKEND_USAGE_SOURCES.map((source) => [source.backend, source.label])]);
const METRICS: ReadonlyArray<{ id: UsageMetric; label: string }> = [{ id: "cost", label: "Cost" }, { id: "tokens", label: "Tokens" }, { id: "turns", label: "Turns" }];
const ORIGINS: ReadonlyArray<{ id: UsageOrigin | "all"; label: string }> = [{ id: "all", label: "All" }, { id: "tau", label: "In Tau" }, { id: "outside", label: "Outside Tau" }];

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
export function jumpTo(id: string): void {
  document.getElementById(id)?.scrollIntoView({ block: "start", behavior: "smooth" });
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
            <NavRow key={option.id ?? "all"} active={filters.machine === option.id} icon={option.id === undefined || option.id === "" ? <Monitor size={14} aria-hidden="true" /> : <Server size={14} aria-hidden="true" />} label={option.label} onSelect={() => view.setFilters({ machine: option.id })} />
          ))}
        </NavGroup>
      ) : null}
      {facts.anyOutside ? (
        <NavGroup heading="Where it ran">
          {ORIGINS.map((option) => <NavRow key={option.id} active={(filters.origin ?? "all") === option.id} label={option.label} onSelect={() => view.setFilters({ origin: option.id === "all" ? undefined : option.id })} />)}
        </NavGroup>
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
        <h2 className="settings-nav-heading">Period</h2>
        <Segmented<UsageRange> label="Range" value={filters.range} options={USAGE_RANGES} onChange={(range) => view.setFilters({ range })} />
      </div>
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

/** Without the sidebar (a phone, a tablet): the month and the filters on top of the page, in one wrapping row. */
export function UsageTopBar({ view }: { view: UsageView }) {
  const { filters, facts } = useView(view);
  return (
    <div className="usage-topbar">
      <MonthFigure month={facts.month} />
      <div className="usage-topbar-filters">
        {facts.machines.length > 0 ? <MachineFilter machines={facts.machines} value={filters.machine} onChange={(machine) => view.setFilters({ machine })} /> : null}
        {facts.anyOutside ? <Segmented<UsageOrigin | "all"> label="Where the work ran" value={filters.origin ?? "all"} options={ORIGINS} onChange={(value) => view.setFilters({ origin: value === "all" ? undefined : value })} /> : null}
        {facts.runtimes.length > 1 ? <RuntimeFilter runtimes={facts.runtimes} value={filters.runtime} onChange={(runtime) => view.setFilters({ runtime })} /> : null}
        <Segmented<UsageRange> label="Range" value={filters.range} options={USAGE_RANGES} onChange={(range) => view.setFilters({ range })} />
        <Segmented<UsageMetric> label="Measure" value={filters.metric} options={METRICS} onChange={(metric) => view.setFilters({ metric })} />
      </div>
    </div>
  );
}
