import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ChartColumn, RefreshCw } from "lucide-react";
import { Empty, errorMessage, ProviderIconStack, SettingsPageAction, tooltipProps, useThreadStore, type HostExtensionClient, type PlatformEnvironments, type PageProps, type ProjectIconSubject, type ThreadStore, type UiProject, type UiSession } from "tau";
import { ActivityCalendar, ReadingHistory } from "./activity.js";
import { jumpTo, PeriodSwitch, RUNTIME_LABELS, UsageFilterButton } from "./controls.js";
import { dailyFigures, dayStarts, HISTORY_DAYS, ofRuntime, periodFrom, rankUsage, runtimesOf, type RankedUsage } from "./dashboard.js";
import { createUsageView, type UsageView } from "./filters.js";
import { UsageForecast } from "./forecast-view.js";
import { createJuicebarChoices, type JuicebarChoices } from "./juicebar-choices.js";
import type { LimitsFeed } from "./limits-feed.js";
import { monthFigures } from "./month.js";
import { UsageHistory } from "./history.js";
import { UsageLimits } from "./limits.js";
import { ModelPrices } from "./prices.js";
import { mergeEntries, mergeLimits, readMachines, useOtherMachines, type MachineRead } from "./machines.js";
import { USAGE_LIMITS_COMMAND, USAGE_SUMMARY_COMMAND, USAGE_REDEEM_RESET_COMMAND, type UsageLimitAccount, type UsageLimitsSummary, type UsageSourceReport, type UsageEntry, type UsageSummary, type UsageSummaryInput } from "./protocol.js";
import { costliestThread, Figure, projectRow, providerRow, UsageStats, UsageTable, type TableRow } from "./overview.js";
import { readLastState, saveLastState } from "./last-state.js";

/** How often an open, visible page reads again. */
const POLL_MS = 5 * 60_000;
/** While a host still reads the CLIs' logs, the page asks again this soon. */
const READING_POLL_MS = 5_000;
function folderName(cwd: string): string {
  return cwd.split(/[\\/]/u).filter(Boolean).pop() ?? cwd;
}

/**
 * What the host is asked for: the page's days after a first "day" at 0, which
 * gathers everything older. Answers come back with that one at day -1.
 */
export function request(starts: readonly number[]): number[] {
  return [0, ...starts];
}

export function fromRequest(summary: UsageSummary): UsageSummary {
  return summary.entries ? { ...summary, entries: summary.entries.map((entry) => ({ ...entry, day: entry.day - 1 })) } : summary;
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

/**
 * What Tau's threads cost and how close each plan is to its limits. The page
 * answers, from the top: what today, this week and this month cost; which
 * plan limit is nearest and when it resets; how the days went; and which
 * projects, models and threads used the most. Money billed per token and
 * what a subscription covered (its value at API prices) are never one figure.
 */
export function UsagePage({ host, environments, actions, params = {}, navigate, now, sidebar = false, view: givenView, feed, choices: givenChoices }: Partial<Omit<PageProps, "params">> & {
  params?: PageProps["params"];
  host: HostExtensionClient;
  environments?: PlatformEnvironments;
  now?: () => Date;
  /** The filters, shared with the page's sidebar. */
  view?: UsageView;
  /** The sidebar's juicebars, handed what the page reads. */
  feed?: LimitsFeed;
  choices?: JuicebarChoices;
}) {
  const shown = environments?.shownElsewhere;
  const [view] = useState(() => givenView ?? createUsageView());
  const [choices] = useState(() => givenChoices ?? createJuicebarChoices());
  const filters = useSyncExternalStore(view.subscribe, view.getFilters);
  const { range, metric, runtime, machine, origin } = filters;
  // What the page read last time, at once; fresh answers replace it section by section.
  const [cached] = useState(() => readLastState(shown, dayStarts(HISTORY_DAYS, now?.())));
  const [summary, setSummary] = useState<UsageSummary | undefined>(cached?.summary);
  const [error, setError] = useState<string>();
  const [limits, setLimits] = useState<UsageLimitsSummary | undefined>(cached?.limits);
  const [limitsError, setLimitsError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [limitsBusy, setLimitsBusy] = useState(false);
  const machines = useOtherMachines(environments);
  const [summaries, setSummaries] = useState<readonly MachineRead[]>([]);
  const [machineLimits, setMachineLimits] = useState<readonly MachineRead[]>([]);
  const [clock, setClock] = useState(() => (now?.() ?? new Date()).getTime());
  const latest = useRef(0);
  const limitsRequest = useRef(0);
  const [days, setDays] = useState(() => dayStarts(HISTORY_DAYS, now?.()));
  const index = useThreadIndex();

  // Each source on its own: this host's answer shows as soon as it is there, other machines' after it.
  const load = useCallback(async (refresh: boolean) => {
    const id = ++latest.current;
    setBusy(true);
    // A new day since the page opened moves every bar along.
    const starts = dayStarts(HISTORY_DAYS, now?.());
    setDays((current) => (current[current.length - 1] === starts[starts.length - 1] ? current : starts));
    const input: UsageSummaryInput = { days: request(starts), ...(refresh ? { refresh } : {}) };
    void readMachines(environments, machines, USAGE_SUMMARY_COMMAND, input).then((others) => {
      if (id === latest.current) setSummaries(others.map((read) => ({ machine: read.machine, ...(read.answer ? { summary: fromRequest(read.answer as UsageSummary) } : {}), ...(read.error ? { error: read.error } : {}) })));
    });
    try {
      const result = fromRequest(await host.invoke(USAGE_SUMMARY_COMMAND, input) as UsageSummary);
      if (id !== latest.current) return;
      setSummary(result);
      setError(undefined);
      saveLastState(shown, { days: starts, summary: result });
    } catch (failure) {
      if (id === latest.current) setError(errorMessage(failure));
    } finally {
      if (id === latest.current) setBusy(false);
    }
  }, [host, now, environments, machines, shown]);

  const loadLimits = useCallback(async (refresh: boolean) => {
    const id = ++limitsRequest.current;
    setLimitsBusy(true);
    const input = refresh ? { refresh } : {};
    void readMachines(environments, machines, USAGE_LIMITS_COMMAND, input).then((others) => {
      if (id === limitsRequest.current) setMachineLimits(others.map((read) => ({ machine: read.machine, ...(read.answer ? { limits: read.answer as UsageLimitsSummary } : {}), ...(read.error ? { error: read.error } : {}) })));
    });
    try {
      const result = await host.invoke(USAGE_LIMITS_COMMAND, input) as UsageLimitsSummary;
      if (id !== limitsRequest.current) return;
      setLimits(result);
      setLimitsError(undefined);
      saveLastState(shown, { days: dayStarts(HISTORY_DAYS, now?.()), limits: result });
    } catch (failure) {
      if (id === limitsRequest.current) setLimitsError(errorMessage(failure));
    } finally {
      // A reading is judged against the clock after it arrived, never before.
      if (id === limitsRequest.current) { setLimitsBusy(false); setClock((now?.() ?? new Date()).getTime()); }
    }
  }, [host, now, environments, machines, shown]);

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
  useEffect(() => { feed?.publish(allLimits); }, [feed, allLimits]);
  const runtimes = useMemo(() => runtimesOf(allEntries), [allEntries]);
  const shownRuntime = runtime && runtimes.includes(runtime) ? runtime : undefined;
  const shownMachine = machine === undefined || machine === "" || machines.some((other) => other.id === machine) ? machine : undefined;
  const anyOutside = useMemo(() => allEntries.some((entry) => entry.outside), [allEntries]);
  const shownOrigin = anyOutside ? origin : undefined;
  const entries = useMemo(() => ofRuntime(allEntries, shownRuntime, shownMachine, shownOrigin), [allEntries, shownRuntime, shownMachine, shownOrigin]);
  const machineName = (id: string | undefined) => (id ? machines.find((other) => other.id === id)?.name ?? "another machine" : undefined);
  const last = days.length;
  const today = now?.() ?? new Date();
  const from = periodFrom(range, days, today);
  // A phone draws the last 12 days, as design 1r; a desktop the period's, 90 days at most.
  const [compact] = useState(() => typeof document !== "undefined" && document.body.dataset.profile === "compact");
  const chartFrom = compact ? last - 12 : Math.max(0, from);
  const series = useMemo(() => {
    const drawn = dailyFigures(entries, days, chartFrom);
    // The month's days still to come stand empty, so the month keeps its width.
    const newest = new Date(days.at(-1) ?? 0);
    const [year, month, date] = [newest.getFullYear(), newest.getMonth(), newest.getDate()];
    const rest = range === "month" && !compact ? new Date(year, month + 1, 0).getDate() - date : 0;
    return [...drawn, ...Array.from({ length: rest }, (_, ahead) => ({ start: new Date(year, month, date + 1 + ahead).getTime(), costUsd: 0, apiValueUsd: 0, totalTokens: 0, requests: 0, planTokens: 0, planRequests: 0 }))];
  }, [chartFrom, compact, days, entries, range]);
  const chartTitle = compact ? "Per day · last 12" : range === "all" ? `Per day · last ${HISTORY_DAYS} days` : "Per day";
  const rangeLabel = range === "month" ? "this month" : range === "30d" ? "the last 30 days" : "all the time kept";
  // What the filters offer and this month's figure, for the sidebar or the bar on top.
  const month = useMemo(() => (summary ? monthFigures(allEntries, days, now?.() ?? new Date()) : undefined), [allEntries, days, now, summary]);
  useEffect(() => { view.setFacts({ runtimes, machines, anyOutside, ...(month ? { month } : {}) }); }, [anyOutside, machines, month, runtimes, view]);
  // Opened at a section (the foot's juicebars open the limits).
  const section = typeof params.section === "string" ? params.section : undefined;
  const jumped = useRef<string>(undefined);
  const laidOut = Boolean(summary && (section !== "limits" || allLimits));
  useEffect(() => {
    // Once what it shows is in: before, the page is too short to scroll there.
    if (!section || !laidOut || jumped.current === section) return;
    jumped.current = section;
    requestAnimationFrame(() => jumpTo(`usage-${section}`, "auto"));
  }, [laidOut, section]);

  const threadIndex = useMemo(() => new Map(index.threads.map((thread) => [thread.id, thread])), [index.threads]);
  // A thread's project, wherever it ran: a worktree's thread (and a CLI run in that worktree) counts with its project, matched as the sidebar does.
  const projectOf = useMemo(() => {
    const learned = new Map<string, string>();
    const find = (path: string, workspaceId?: string, name?: string) => index.projects.find((project) => project.path === path || (workspaceId && project.workspaceId === workspaceId) || path.startsWith(`${project.path}/`))
      ?? (name ? index.projects.find((project) => project.name === name) : undefined);
    const direct = (entry: UsageEntry): string | undefined => {
      if (entry.machine) return entry.cwd;
      const thread = entry.outside ? undefined : threadIndex.get(entry.threadId);
      const project = thread ? find(thread.projectPath, thread.workspaceId, thread.projectName) : find(entry.cwd);
      return project ? project.workspaceId ?? project.path : thread ? thread.workspaceId ?? thread.projectPath : undefined;
    };
    for (const entry of allEntries) {
      const key = !entry.outside && !entry.machine && threadIndex.has(entry.threadId) ? direct(entry) : undefined;
      if (key && !learned.has(entry.cwd)) learned.set(entry.cwd, key);
    }
    return (entry: UsageEntry) => direct(entry) ?? learned.get(entry.cwd) ?? entry.cwd;
  }, [allEntries, index.projects, threadIndex]);
  const projectSubject = (key: string, cwd: string): ProjectIconSubject => {
    const project = index.projects.find((item) => item.workspaceId === key || item.path === key);
    if (project) return project;
    const thread = index.threads.find((item) => (item.workspaceId ?? item.projectPath) === key);
    return { path: thread?.projectDisplayPath ?? key, name: thread?.projectName ?? folderName(cwd), ...(thread?.workspaceId ? { workspaceId: thread.workspaceId } : {}) };
  };
  const projectName = (cwd: string) => index.projects.find((project) => project.path === cwd || project.workspaceId === cwd)?.name ?? folderName(cwd);
  const threadOf = (threadId: string | undefined) => (threadId ? threadIndex.get(threadId) : undefined);
  const providers = rankUsage(entries, from, "provider", metric, 8).map(providerRow);
  const projects = rankUsage(entries, from, "project", metric, 6, projectOf).map((item) => {
    const key = item.key.slice(item.key.indexOf("\u0000") + 1);
    const where = [item.origin === "outside" ? "Outside Tau" : item.origin === "both" ? "Also outside Tau" : undefined, machineName(item.machine)].filter(Boolean).join(" · ");
    return projectRow(item, projectSubject(key, item.cwd), where || undefined);
  });
  const ranked = rankUsage(entries, from, "thread", metric, Number.MAX_SAFE_INTEGER);
  const costliest = costliestThread(ranked, threadIndex, metric);
  const marks = (item: RankedUsage) => <ProviderIconStack runtimeProvider={item.backend} {...(item.provider ? { modelProvider: item.provider } : {})} hint={{ side: "top" }} />;
  const models: TableRow[] = rankUsage(entries, from, "model", metric, 6).map((item) => ({ item, name: item.model, mark: marks(item), title: RUNTIME_LABELS[item.backend] ?? item.backend }));
  const threads: TableRow[] = ranked.slice(0, 8).map((item) => {
    const outside = item.origin === "outside";
    const thread = item.machine || outside ? undefined : threadOf(item.threadId);
    return {
      item,
      name: thread?.title || (outside ? `${RUNTIME_LABELS[item.backend] ?? item.backend} session ${item.threadId?.slice(0, 8) ?? ""}` : `Thread ${item.threadId?.slice(0, 8) ?? ""}`),
      title: [outside ? "Outside Tau" : undefined, projectName(item.cwd), machineName(item.machine)].filter(Boolean).join(" · "),
      mark: marks(item),
      ...(thread && actions ? { onOpen: () => { void actions.switchSession(thread.path); } } : {}),
    };
  });

  if (params.view === "prices") {
    const suggestions = [...new Set((summary?.rows ?? []).map((row) => row.provider ? `${row.provider}/${row.modelId ?? row.model}` : row.modelId ?? row.model))].sort();
    return <div className="usage-subpage"><ModelPrices suggestions={suggestions} /></div>;
  }
  if (params.view === "sources") return <Sources summary={summary} limits={allLimits} machines={summaries} />;

  const read = summary ? `Read ${new Date(summary.scannedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}` : "Reading usage…";
  const status = busy && !summary ? "Reading…" : `${machines.length > 0 ? `${read} · this computer and ${machines.map((other) => other.name).join(", ")}` : read}${busy ? " · updating…" : logsReading ? " · still reading the CLIs' logs" : ""}`;
  return (
    <div className={`usage-page${busy && summary ? " refreshing" : ""}`}>
      <SettingsPageAction>
        <div className="usage-toolbar">
          <span role="status" className="usage-read" data-active={busy || logsReading ? "" : undefined}>{status}</span>
          {sidebar ? <button type="button" className="usage-icon-button" aria-label="Read usage and limits again" disabled={busy || limitsBusy} onClick={readAgain} {...tooltipProps(status, { side: "bottom" })}><RefreshCw size={14} /></button> : null}
          <PeriodSwitch view={view} now={today} />
          {sidebar ? null : <UsageFilterButton view={view} now={today} status={status} busy={busy || limitsBusy} onReadAgain={readAgain} />}
        </div>
      </SettingsPageAction>

      {error && !summary ? (
        <Empty icon={<ChartColumn size={18} />} title="Usage could not be read" description={error}>
          <button type="button" className="mini-button" onClick={readAgain}>Try again</button>
        </Empty>
      ) : (
        <>
          {error ? <p className="usage-note" data-level="error">{error} The figures are from the last read.</p> : null}
          {summary && allEntries.length === 0 ? (
            <Empty icon={<ChartColumn size={18} />} title="Nothing used yet" description="Usage shows up here once a thread has answered. The sources say what was read.">
              {navigate ? <button type="button" className="mini-button" onClick={() => navigate({ view: "sources" }, { label: "Sources" })}>Sources</button> : null}
            </Empty>
          ) : (
            <div className="usage-overview">
              <UsageStats entries={entries} from={from} weekFrom={last - 7} threads={threadIndex} />
              <UsageHistory series={series} metric={metric} title={chartTitle} />
              <UsageForecast entries={entries} days={days} now={today} />
              <div className="usage-tables">
                <UsageTable id="usage-providers" title="By provider" rows={providers} metric={metric} bars empty={`Nothing in ${rangeLabel}.`} />
                <UsageTable id="usage-projects" title="By project" rows={projects} metric={metric} empty={`Nothing in ${rangeLabel}.`}>
                  {costliest ? (
                    <p className="usage-costliest">
                      Most expensive thread:{" "}
                      {actions ? <button type="button" className="usage-link" onClick={() => { void actions.switchSession(costliest.thread.path); }}>{costliest.thread.title || "Untitled thread"}</button> : <span>{costliest.thread.title}</span>}
                      {" · "}<Figure item={costliest.item} metric={metric} />{costliest.agents > 0 ? ` across ${costliest.agents} ${costliest.agents === 1 ? "agent" : "agents"}` : ""}
                    </p>
                  ) : null}
                </UsageTable>
              </div>
            </div>
          )}

          <section className="usage-section" id="usage-limits" aria-labelledby="usage-limits-title">
            <h2 id="usage-limits-title">Plan limits</h2>
            <UsageLimits onRedeemReset={async (account: UsageLimitAccount, checkPending?: boolean) => {
              const input = { runtime: account.runtime, accountId: account.id, identity: account.identity?.key, checkPending: checkPending === true };
              try {
                const outcome = account.machine
                  ? await (environments?.invokeExtension ? environments.invokeExtension(account.machine, "tau.usage", USAGE_REDEEM_RESET_COMMAND, input) : Promise.reject(new Error("This Tau version cannot redeem a reset on another machine.")))
                  : await host.invoke(USAGE_REDEEM_RESET_COMMAND, input);
                return outcome === "reset" ? "Reset applied. The limits have been refreshed." : outcome === "nothingToReset" ? "The account is not limited yet." : outcome === "alreadyRedeemed" ? "This reset was already applied." : outcome === "alreadySettled" ? "The previous reset request is finished. The limits have been refreshed." : "No reset is available.";
              } finally { await loadLimits(true); }
            }} limits={allLimits} error={limitsError} now={clock} entries={allEntries} fromDay={last - 30} period="Last 30 days" choices={choices} onRetry={() => void loadLimits(true)} {...(actions ? { onOpenExternal: (url: string) => actions.openExternal(url) } : {})} />
            {allLimits ? <ReadingHistory limits={allLimits} now={clock} /> : null}
          </section>

          {summary && allEntries.length > 0 ? (
            <section className="usage-section" id="usage-activity" aria-labelledby="usage-activity-title">
              <h2 id="usage-activity-title">Activity</h2>
              <ActivityCalendar days={days} entries={entries} labels={RUNTIME_LABELS} />
              <div className="usage-ranks">
                <UsageTable id="usage-models" title="Models" rows={models} metric={metric} empty={`Nothing in ${rangeLabel}.`} />
                <UsageTable title="Threads" rows={threads} metric={metric} counts={false} empty={`Nothing in ${rangeLabel}.`} />
              </div>
            </section>
          ) : null}

          {navigate ? (
            <footer className="usage-footer">
              <button type="button" className="usage-link" onClick={() => navigate({ view: "prices" }, { label: "Model prices" })}>Model prices</button>
              <button type="button" className="usage-link" onClick={() => navigate({ view: "sources" }, { label: "Sources" })}>Sources</button>
              <span>API spend is money an API key was charged per token; plans show as tokens, ≈ marks their value at API prices.</span>
            </footer>
          ) : null}
        </>
      )}
    </div>
  );
}
