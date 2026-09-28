import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChartColumn, RefreshCw } from "lucide-react";
import { Empty, errorMessage, formatCost, ProviderIconStack, tooltipProps, useThreadStore, type HostExtensionClient, type PlatformEnvironments, type PageProps, type ThreadStore, type UiProject, type UiSession } from "tau";
import { ActivityCalendar, ReadingHistory } from "./activity.js";
import { dailyFigures, dayStarts, figuresFrom, HISTORY_DAYS, ofRuntime, rankUsage, runtimesOf, USAGE_RANGES, type UsageFigures, type UsageMetric, type UsageOrigin, type UsageRange } from "./dashboard.js";
import { UsageHistory } from "./history.js";
import { UsageLimits } from "./limits.js";
import { ModelPrices } from "./prices.js";
import { mergeEntries, mergeLimits, useOtherMachines, type MachineRead, type UsageMachine } from "./machines.js";
import { BACKEND_USAGE_SOURCES, PI_BACKEND, USAGE_EXTENSION_ID, USAGE_LIMITS_COMMAND, USAGE_SUMMARY_COMMAND, type UsageLimitsSummary, type UsageSourceReport, type UsageSummary, type UsageSummaryInput } from "./protocol.js";
import { RankList, type RankRow } from "./top-lists.js";
import { formatTokens } from "./view-model.js";

const METRICS: ReadonlyArray<{ id: UsageMetric; label: string }> = [{ id: "cost", label: "Cost" }, { id: "tokens", label: "Tokens" }, { id: "turns", label: "Turns" }];
const ORIGINS: ReadonlyArray<{ id: UsageOrigin | "all"; label: string }> = [{ id: "all", label: "All" }, { id: "tau", label: "In Tau" }, { id: "outside", label: "Outside Tau" }];
/** How often an open, visible page reads again. */
const POLL_MS = 5 * 60_000;
/** While a host still reads the CLIs' logs, the page asks again this soon. */
const READING_POLL_MS = 5_000;
const RUNTIME_LABELS: Record<string, string> = Object.fromEntries([[PI_BACKEND, "Pi"], ...BACKEND_USAGE_SOURCES.map((source) => [source.backend, source.label])]);

function folderName(cwd: string): string {
  return cwd.split(/[\\/]/u).filter(Boolean).pop() ?? cwd;
}

/** The window's threads and projects; a page drawn outside a workbench (a test) has none. */
function useThreadIndex(): { threads: readonly UiSession[]; projects: readonly UiProject[] } {
  let store: ThreadStore | undefined;
  try { store = useThreadStore(); } catch { store = undefined; }
  const [index, setIndex] = useState(() => ({ threads: store?.getSnapshot().threads ?? [], projects: store?.getProjects() ?? [] }));
  useEffect(() => {
    if (!store) return undefined;
    const read = () => setIndex({ threads: store!.getSnapshot().threads, projects: store!.getProjects() });
    const stopThreads = store.subscribe(read);
    const stopProjects = store.subscribeToProjects(read);
    return () => { stopThreads(); stopProjects(); };
  }, [store]);
  return index;
}

function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: ReadonlyArray<{ id: T; label: string }>; onChange(value: T): void }) {
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

/** Every machine, this one (`""`), or another by its host id. */
function MachineFilter({ machines, value, onChange }: { machines: readonly UsageMachine[]; value: string | undefined; onChange(value: string | undefined): void }) {
  const options: Array<{ id: string | undefined; label: string }> = [{ id: undefined, label: "All machines" }, { id: "", label: "This computer" }, ...machines.map((machine) => ({ id: machine.id, label: machine.name }))];
  return (
    <div className="segmented usage-segmented" role="radiogroup" aria-label="Machine">
      {options.map((option) => (
        <button key={option.id ?? "all"} type="button" role="radio" aria-checked={value === option.id} className={value === option.id ? "active" : ""} onClick={() => onChange(option.id)}>{option.label}</button>
      ))}
    </div>
  );
}

/** A period's money, billed and a plan's value side by side, over what it used. */
function PeriodTile({ label, figures }: { label: string; figures: UsageFigures }) {
  const billed = formatCost(figures.costUsd);
  const plan = formatCost(figures.apiValueUsd);
  return (
    <section className="usage-kpi" aria-label={label}>
      <h3>{label}</h3>
      <div className="usage-kpi-figures">
        <p data-empty={billed ? undefined : "true"}><b>{billed ?? "$0"}</b><small>billed</small></p>
        <p className="plan" data-empty={plan ? undefined : "true"}><b>{plan ? `≈ ${plan}` : "—"}</b><small>plan value</small></p>
      </div>
      <p className="usage-kpi-detail">{formatTokens(figures.totalTokens)} tokens · {figures.requests} {figures.requests === 1 ? "turn" : "turns"} · {figures.threads} {figures.threads === 1 ? "thread" : "threads"}</p>
    </section>
  );
}

function Sources({ summary, limits, machines = [] }: { summary: UsageSummary | undefined; limits: UsageLimitsSummary | undefined; machines?: readonly MachineRead[] }) {
  const status = (value: UsageSourceReport["status"]) => value === "ok" ? "read" : value === "empty" ? "no data" : value === "reading" ? "reading" : "not available";
  return (
    <div className="usage-subpage">
      <p className="lede">
        Where the figures come from. Pi writes every response with its tokens into its session files; the Codex, Agent SDK, Antigravity,
        OpenCode, Grok and Cursor kits keep every turn. Work outside Tau comes from the logs the Codex, Claude Code and OpenCode CLIs keep
        on their own, in the folders each runtime&apos;s settings name; only counts are read, and a session a Tau thread ran counts once, with
        its thread. Limits are what a runtime&apos;s login reports about its plan. Nothing here is a bill:
        billed is what an API key was charged per token, plan value is what a subscription&apos;s tokens would have cost over the provider&apos;s API.
      </p>
      <ul className="usage-sources" aria-label="Sources">
        {summary?.sources.map((source) => (
          <li key={source.backend} data-status={source.status}>
            <strong>{source.label}</strong><em className="usage-status">{status(source.status)}</em><span>{source.detail}</span>
          </li>
        ))}
        {machines.map((read) => (
          <li key={`machine-${read.machine.id}`} data-status={read.summary ? "ok" : "unavailable"}>
            <strong>Usage on {read.machine.name}</strong><em className="usage-status">{status(read.summary ? "ok" : "unavailable")}</em>
            <span>{read.summary ? `${read.summary.entries?.length ?? 0} entries over the last ${HISTORY_DAYS} days.` : `Not available: ${read.error ?? "no answer"}.`}</span>
          </li>
        ))}
        {limits?.sources.map((source) => (
          <li key={`limits-${source.extensionId}`} data-status={source.status}>
            <strong>{source.label} limits</strong><em className="usage-status">{status(source.status)}</em><span>{source.detail}</span>
          </li>
        ))}
      </ul>
      {summary ? <p className="usage-note">Last read {new Date(summary.scannedAt).toLocaleTimeString()}.</p> : null}
    </div>
  );
}

/** A Usage command on each other machine; one that fails says why and keeps the rest. */
async function readMachines(environments: PlatformEnvironments | undefined, machines: readonly UsageMachine[], command: string, input: unknown): Promise<Array<{ machine: UsageMachine; answer?: unknown; error?: string }>> {
  const read = environments?.readExtension;
  if (!read || machines.length === 0) return [];
  return Promise.all(machines.map(async (machine) => {
    try {
      return { machine, answer: await read(machine.id, USAGE_EXTENSION_ID, command, input) };
    } catch (failure) {
      return { machine, error: errorMessage(failure) };
    }
  }));
}

/**
 * What Tau's threads cost and how close each plan is to its limits. The page
 * answers, from the top: what today, this week and this month cost; which
 * plan limit is nearest and when it resets; how the days went; and which
 * projects, models and threads used the most. Money billed per token and
 * what a subscription covered (its value at API prices) are never one figure.
 */
export function UsagePage({ host, environments, actions, params = {}, navigate, now }: Partial<Omit<PageProps, "params">> & { params?: PageProps["params"]; host: HostExtensionClient; environments?: PlatformEnvironments; now?: () => Date }) {
  const [range, setRange] = useState<UsageRange>("30d");
  const [metric, setMetric] = useState<UsageMetric>("cost");
  const [summary, setSummary] = useState<UsageSummary>();
  const [error, setError] = useState<string>();
  const [limits, setLimits] = useState<UsageLimitsSummary>();
  const [limitsError, setLimitsError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [limitsBusy, setLimitsBusy] = useState(false);
  const [runtime, setRuntime] = useState<string>();
  const [machine, setMachine] = useState<string>();
  const [origin, setOrigin] = useState<UsageOrigin>();
  const machines = useOtherMachines(environments);
  const [summaries, setSummaries] = useState<readonly MachineRead[]>([]);
  const [machineLimits, setMachineLimits] = useState<readonly MachineRead[]>([]);
  const [clock, setClock] = useState(() => (now?.() ?? new Date()).getTime());
  const request = useRef(0);
  const limitsRequest = useRef(0);
  const [days, setDays] = useState(() => dayStarts(HISTORY_DAYS, now?.()));
  const index = useThreadIndex();

  const load = useCallback(async (refresh: boolean) => {
    const id = ++request.current;
    setBusy(true);
    // A new day since the page opened moves every bar along.
    const starts = dayStarts(HISTORY_DAYS, now?.());
    setDays((current) => (current[current.length - 1] === starts[starts.length - 1] ? current : starts));
    const input: UsageSummaryInput = { since: starts[0]!, days: starts, ...(refresh ? { refresh } : {}) };
    try {
      const [result, others] = await Promise.all([host.invoke(USAGE_SUMMARY_COMMAND, input) as Promise<UsageSummary>, readMachines(environments, machines, USAGE_SUMMARY_COMMAND, input)]);
      if (id !== request.current) return;
      setSummary(result);
      setSummaries(others.map((read) => ({ machine: read.machine, ...(read.answer ? { summary: read.answer as UsageSummary } : {}), ...(read.error ? { error: read.error } : {}) })));
      setError(undefined);
    } catch (failure) {
      if (id === request.current) setError(errorMessage(failure));
    } finally {
      if (id === request.current) setBusy(false);
    }
  }, [host, now, environments, machines]);

  const loadLimits = useCallback(async (refresh: boolean) => {
    const id = ++limitsRequest.current;
    setLimitsBusy(true);
    try {
      const input = refresh ? { refresh } : {};
      const [result, others] = await Promise.all([host.invoke(USAGE_LIMITS_COMMAND, input) as Promise<UsageLimitsSummary>, readMachines(environments, machines, USAGE_LIMITS_COMMAND, input)]);
      if (id !== limitsRequest.current) return;
      setLimits(result);
      setMachineLimits(others.map((read) => ({ machine: read.machine, ...(read.answer ? { limits: read.answer as UsageLimitsSummary } : {}), ...(read.error ? { error: read.error } : {}) })));
      setLimitsError(undefined);
    } catch (failure) {
      if (id === limitsRequest.current) setLimitsError(errorMessage(failure));
    } finally {
      // A reading is judged against the clock after it arrived, never before.
      if (id === limitsRequest.current) { setLimitsBusy(false); setClock((now?.() ?? new Date()).getTime()); }
    }
  }, [host, now, environments, machines]);

  useEffect(() => { void load(false); void loadLimits(false); }, [load, loadLimits]);
  // Countdowns move on; while the page is open and seen, the limits are read anew, which is what a forecast needs.
  const polling = useRef({ load, loadLimits, busy: false });
  polling.current = { load, loadLimits, busy: busy || limitsBusy };
  useEffect(() => {
    const tick = setInterval(() => setClock((now?.() ?? new Date()).getTime()), 30_000);
    const poll = setInterval(() => {
      const { load: read, loadLimits: readLimits, busy: reading } = polling.current;
      if (reading || document.visibilityState !== "visible") return;
      void read(false);
      void readLimits(true);
    }, POLL_MS);
    return () => { clearInterval(tick); clearInterval(poll); };
  }, [now]);
  const readAgain = () => { void load(true); void loadLimits(true); };
  // A first read of a large log history answers in parts; the page asks again until it is whole.
  const logsReading = Boolean(summary?.reading || summaries.some((read) => read.summary?.reading));
  useEffect(() => {
    if (!logsReading || busy) return undefined;
    const again = setTimeout(() => { void polling.current.load(false); }, READING_POLL_MS);
    return () => clearTimeout(again);
  }, [logsReading, busy]);

  const allEntries = useMemo(() => mergeEntries(summary?.entries ?? [], summaries), [summary, summaries]);
  const allLimits = useMemo(() => mergeLimits(limits, machineLimits), [limits, machineLimits]);
  const runtimes = useMemo(() => runtimesOf(allEntries), [allEntries]);
  const shownRuntime = runtime && runtimes.includes(runtime) ? runtime : undefined;
  const shownMachine = machine === undefined || machine === "" || machines.some((other) => other.id === machine) ? machine : undefined;
  const anyOutside = useMemo(() => allEntries.some((entry) => entry.outside), [allEntries]);
  const shownOrigin = anyOutside ? origin : undefined;
  const entries = useMemo(() => ofRuntime(allEntries, shownRuntime, shownMachine, shownOrigin), [allEntries, shownRuntime, shownMachine, shownOrigin]);
  const machineName = (id: string | undefined) => (id ? machines.find((other) => other.id === id)?.name ?? "another machine" : undefined);
  const last = days.length;
  const from = last - (USAGE_RANGES.find((entry) => entry.id === range)?.days ?? 30);
  const series = useMemo(() => dailyFigures(entries, days, from), [days, entries, from]);
  const rangeLabel = USAGE_RANGES.find((entry) => entry.id === range)?.label ?? "";

  const projectName = (cwd: string) => index.projects.find((project) => project.path === cwd || project.workspaceId === cwd)?.name ?? folderName(cwd);
  const threadOf = (threadId: string | undefined) => (threadId ? index.threads.find((thread) => thread.id === threadId) : undefined);
  const projects: RankRow[] = rankUsage(entries, from, "project", metric, 6).map((item) => {
    const where = [item.origin === "outside" ? "Outside Tau" : item.origin === "both" ? "Also outside Tau" : undefined, machineName(item.machine)].filter(Boolean).join(" · ");
    return { item, name: projectName(item.cwd), title: item.cwd, ...(where ? { detail: where } : {}) };
  });
  const models: RankRow[] = rankUsage(entries, from, "model", metric, 6).map((item) => ({
    item,
    name: item.model,
    detail: RUNTIME_LABELS[item.backend] ?? item.backend,
    marks: { runtimeProvider: item.backend, ...(item.provider ? { modelProvider: item.provider } : {}) },
  }));
  const threads: RankRow[] = rankUsage(entries, from, "thread", metric, 8).map((item) => {
    const outside = item.origin === "outside";
    const thread = item.machine || outside ? undefined : threadOf(item.threadId);
    return {
      item,
      name: thread?.title || (outside ? `${RUNTIME_LABELS[item.backend] ?? item.backend} session ${item.threadId?.slice(0, 8) ?? ""}` : `Thread ${item.threadId?.slice(0, 8) ?? ""}`),
      detail: [outside ? "Outside Tau" : undefined, projectName(item.cwd), machineName(item.machine)].filter(Boolean).join(" · "),
      marks: { runtimeProvider: item.backend, ...(item.provider ? { modelProvider: item.provider } : {}) },
      ...(thread && actions ? { onOpen: () => { void actions.switchSession(thread.path); } } : {}),
    };
  });

  if (params.view === "prices") {
    const suggestions = [...new Set((summary?.rows ?? []).map((row) => row.provider ? `${row.provider}/${row.modelId ?? row.model}` : row.modelId ?? row.model))].sort();
    return <div className="usage-subpage"><ModelPrices suggestions={suggestions} /></div>;
  }
  if (params.view === "sources") return <Sources summary={summary} limits={allLimits} machines={summaries} />;

  const read = summary ? `Read ${new Date(summary.scannedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}` : "Reading usage…";
  return (
    <div className={`usage-page${busy && summary ? " refreshing" : ""}`}>
      <div className="usage-toolbar">
        <span role="status">{busy ? "Reading…" : `${machines.length > 0 ? `${read} · this computer and ${machines.map((other) => other.name).join(", ")}` : read}${logsReading ? " · still reading the CLIs' logs" : ""}`}</span>
        <button type="button" className="usage-icon-button" aria-label="Read usage and limits again" disabled={busy || limitsBusy} onClick={readAgain}><RefreshCw size={14} /></button>
      </div>

      {error && !summary ? (
        <Empty icon={<ChartColumn size={18} />} title="Usage could not be read" description={error}>
          <button type="button" className="mini-button" onClick={readAgain}>Try again</button>
        </Empty>
      ) : (
        <>
          {error ? <p className="usage-note" data-level="error">{error} The figures are from the last read.</p> : null}
          <div className="usage-kpis" aria-label="Totals">
            <PeriodTile label="Today" figures={figuresFrom(allEntries, last - 1)} />
            <PeriodTile label="Last 7 days" figures={figuresFrom(allEntries, last - 7)} />
            <PeriodTile label="Last 30 days" figures={figuresFrom(allEntries, last - 30)} />
          </div>

          <section className="usage-section" aria-labelledby="usage-limits-title">
            <h2 id="usage-limits-title">Plan limits</h2>
            <UsageLimits limits={allLimits} error={limitsError} now={clock} entries={allEntries} fromDay={last - 30} period="Last 30 days" onRetry={() => void loadLimits(true)} />
            {allLimits ? <ReadingHistory limits={allLimits} now={clock} /> : null}
          </section>

          <section className="usage-section" aria-labelledby="usage-breakdown-title">
            <header className="usage-section-head">
              <h2 id="usage-breakdown-title">Activity</h2>
              <span className="spacer" />
              {machines.length > 0 ? <MachineFilter machines={machines} value={shownMachine} onChange={setMachine} /> : null}
              {anyOutside ? <Segmented<UsageOrigin | "all"> label="Where the work ran" value={shownOrigin ?? "all"} options={ORIGINS} onChange={(value) => setOrigin(value === "all" ? undefined : value)} /> : null}
              {runtimes.length > 1 ? <RuntimeFilter runtimes={runtimes} value={shownRuntime} onChange={setRuntime} /> : null}
              <Segmented<UsageRange> label="Range" value={range} options={USAGE_RANGES} onChange={setRange} />
              <Segmented<UsageMetric> label="Measure" value={metric} options={METRICS} onChange={setMetric} />
            </header>
            {summary && allEntries.length === 0 ? (
              <Empty icon={<ChartColumn size={18} />} title="Nothing used yet" description="Usage shows up here once a thread has answered. The sources say what was read.">
                {navigate ? <button type="button" className="mini-button" onClick={() => navigate({ view: "sources" }, { label: "Sources" })}>Sources</button> : null}
              </Empty>
            ) : (
              <>
                <div className="usage-days">
                  <ActivityCalendar days={days} entries={entries} labels={RUNTIME_LABELS} />
                  <UsageHistory series={series} metric={metric} />
                </div>
                <div className="usage-ranks">
                  <RankList title="Projects" rows={projects} metric={metric} empty={`Nothing in the last ${rangeLabel}.`} />
                  <RankList title="Models" rows={models} metric={metric} empty={`Nothing in the last ${rangeLabel}.`} />
                  <RankList title="Threads" rows={threads} metric={metric} empty={`Nothing in the last ${rangeLabel}.`} />
                </div>
              </>
            )}
          </section>

          {navigate ? (
            <footer className="usage-footer">
              <button type="button" className="usage-link" onClick={() => navigate({ view: "prices" }, { label: "Model prices" })}>Model prices</button>
              <button type="button" className="usage-link" onClick={() => navigate({ view: "sources" }, { label: "Sources" })}>Sources</button>
              <span>Billed is money an API key was charged per token; plan value is what a subscription&apos;s tokens would have cost over the API.</span>
            </footer>
          ) : null}
        </>
      )}
    </div>
  );
}
