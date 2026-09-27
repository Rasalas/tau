import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChartColumn, RefreshCw } from "lucide-react";
import { Empty, errorMessage, formatCost, useThreadStore, type HostExtensionClient, type PageProps, type ThreadStore, type UiProject, type UiSession } from "tau";
import { dailyFigures, dayStarts, figuresFrom, HISTORY_DAYS, rankUsage, USAGE_RANGES, type UsageFigures, type UsageMetric, type UsageRange } from "./dashboard.js";
import { UsageHistory } from "./history.js";
import { UsageLimits } from "./limits.js";
import { ModelPrices } from "./prices.js";
import { BACKEND_USAGE_SOURCES, PI_BACKEND, USAGE_LIMITS_COMMAND, USAGE_SUMMARY_COMMAND, type UsageLimitsSummary, type UsageSummary, type UsageSummaryInput } from "./protocol.js";
import { RankList, type RankRow } from "./top-lists.js";
import { formatTokens } from "./view-model.js";

const METRICS: ReadonlyArray<{ id: UsageMetric; label: string }> = [{ id: "cost", label: "Cost" }, { id: "tokens", label: "Tokens" }];
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

function Sources({ summary, limits }: { summary: UsageSummary | undefined; limits: UsageLimitsSummary | undefined }) {
  const status = (value: "ok" | "empty" | "unavailable") => value === "ok" ? "read" : value === "empty" ? "no data" : "not available";
  return (
    <div className="usage-subpage">
      <p className="lede">
        Where the figures come from. Pi writes every response with its tokens into its session files; the Codex, Agent SDK, Antigravity,
        OpenCode, Grok and Cursor kits keep every turn. Limits are what a runtime&apos;s login reports about its plan. Nothing here is a bill:
        billed is what an API key was charged per token, plan value is what a subscription&apos;s tokens would have cost over the provider&apos;s API.
      </p>
      <ul className="usage-sources" aria-label="Sources">
        {summary?.sources.map((source) => (
          <li key={source.backend} data-status={source.status}>
            <strong>{source.label}</strong><em className="usage-status">{status(source.status)}</em><span>{source.detail}</span>
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
export function UsagePage({ host, actions, params = {}, navigate, now }: Partial<Omit<PageProps, "params">> & { params?: PageProps["params"]; host: HostExtensionClient; now?: () => Date }) {
  const [range, setRange] = useState<UsageRange>("30d");
  const [metric, setMetric] = useState<UsageMetric>("cost");
  const [summary, setSummary] = useState<UsageSummary>();
  const [error, setError] = useState<string>();
  const [limits, setLimits] = useState<UsageLimitsSummary>();
  const [limitsError, setLimitsError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const request = useRef(0);
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
      const result = await host.invoke(USAGE_SUMMARY_COMMAND, input) as UsageSummary;
      if (id !== request.current) return;
      setSummary(result);
      setError(undefined);
    } catch (failure) {
      if (id === request.current) setError(errorMessage(failure));
    } finally {
      if (id === request.current) setBusy(false);
    }
  }, [host, now]);

  const loadLimits = useCallback(async (refresh: boolean) => {
    try {
      setLimits(await host.invoke(USAGE_LIMITS_COMMAND, refresh ? { refresh } : {}) as UsageLimitsSummary);
      setLimitsError(undefined);
    } catch (failure) {
      setLimitsError(errorMessage(failure));
    }
  }, [host]);

  useEffect(() => { void load(false); void loadLimits(false); }, [load, loadLimits]);
  const readAgain = () => { void load(true); void loadLimits(true); };

  const entries = useMemo(() => summary?.entries ?? [], [summary]);
  const last = days.length;
  const from = last - (USAGE_RANGES.find((entry) => entry.id === range)?.days ?? 30);
  const series = useMemo(() => dailyFigures(entries, days, from), [days, entries, from]);
  const clock = (now?.() ?? new Date()).getTime();
  const rangeLabel = USAGE_RANGES.find((entry) => entry.id === range)?.label ?? "";

  const projectName = (cwd: string) => index.projects.find((project) => project.path === cwd || project.workspaceId === cwd)?.name ?? folderName(cwd);
  const threadOf = (threadId: string | undefined) => (threadId ? index.threads.find((thread) => thread.id === threadId) : undefined);
  const projects: RankRow[] = rankUsage(entries, from, "project", metric, 6).map((item) => ({ item, name: projectName(item.cwd), title: item.cwd }));
  const models: RankRow[] = rankUsage(entries, from, "model", metric, 6).map((item) => ({
    item,
    name: item.model,
    detail: RUNTIME_LABELS[item.backend] ?? item.backend,
    marks: { runtimeProvider: item.backend, ...(item.provider ? { modelProvider: item.provider } : {}) },
  }));
  const threads: RankRow[] = rankUsage(entries, from, "thread", metric, 8).map((item) => {
    const thread = threadOf(item.threadId);
    return {
      item,
      name: thread?.title || `Thread ${item.threadId?.slice(0, 8) ?? ""}`,
      detail: projectName(item.cwd),
      marks: { runtimeProvider: item.backend, ...(item.provider ? { modelProvider: item.provider } : {}) },
      ...(thread && actions ? { onOpen: () => { void actions.switchSession(thread.path); } } : {}),
    };
  });

  if (params.view === "prices") {
    const suggestions = [...new Set((summary?.rows ?? []).map((row) => row.provider ? `${row.provider}/${row.modelId ?? row.model}` : row.modelId ?? row.model))].sort();
    return <div className="usage-subpage"><ModelPrices suggestions={suggestions} /></div>;
  }
  if (params.view === "sources") return <Sources summary={summary} limits={limits} />;

  const read = summary ? `Read ${new Date(summary.scannedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}` : "Reading usage…";
  return (
    <div className={`usage-page${busy && summary ? " refreshing" : ""}`}>
      <div className="usage-toolbar">
        <span role="status">{busy ? "Reading…" : read}</span>
        <button type="button" className="usage-icon-button" aria-label="Read usage and limits again" disabled={busy} onClick={readAgain}><RefreshCw size={14} /></button>
      </div>

      {error && !summary ? (
        <Empty icon={<ChartColumn size={18} />} title="Usage could not be read" description={error}>
          <button type="button" className="mini-button" onClick={readAgain}>Try again</button>
        </Empty>
      ) : (
        <>
          {error ? <p className="usage-note" data-level="error">{error} The figures are from the last read.</p> : null}
          <div className="usage-kpis" aria-label="Totals">
            <PeriodTile label="Today" figures={figuresFrom(entries, last - 1)} />
            <PeriodTile label="Last 7 days" figures={figuresFrom(entries, last - 7)} />
            <PeriodTile label="Last 30 days" figures={figuresFrom(entries, last - 30)} />
          </div>

          <section className="usage-section" aria-labelledby="usage-limits-title">
            <h2 id="usage-limits-title">Plan limits</h2>
            <UsageLimits limits={limits} error={limitsError} now={clock} />
          </section>

          <section className="usage-section" aria-labelledby="usage-breakdown-title">
            <header className="usage-section-head">
              <h2 id="usage-breakdown-title">Last {rangeLabel}</h2>
              <span className="spacer" />
              <Segmented<UsageRange> label="Range" value={range} options={USAGE_RANGES} onChange={setRange} />
              <Segmented<UsageMetric> label="Measure" value={metric} options={METRICS} onChange={setMetric} />
            </header>
            {summary && entries.length === 0 ? (
              <Empty icon={<ChartColumn size={18} />} title="Nothing used yet" description="Usage shows up here once a thread has answered. The sources say what was read.">
                {navigate ? <button type="button" className="mini-button" onClick={() => navigate({ view: "sources" }, { label: "Sources" })}>Sources</button> : null}
              </Empty>
            ) : (
              <>
                <UsageHistory series={series} metric={metric} />
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
