import type { ReactNode } from "react";
import { formatCost, ProjectIcon, ProviderIconStack, providerStackLabel, tooltipProps, type ProjectIconSubject, type UiSession } from "tau";
import { measure, onPlan, providerOf, type RankedUsage, type UsageMetric } from "./dashboard.js";
import type { UsageEntry } from "./protocol.js";
import { formatTokens } from "./view-model.js";

const LOCAL = new Set(["ollama", "lmstudio", "lm-studio", "llamacpp", "llama.cpp", "vllm", "local"]);
/** A subscription by the name its provider sells it under. */
const PLAN_NAMES: Record<string, string> = { anthropic: "Claude", openai: "ChatGPT", google: "Gemini", xai: "Grok" };

const money = (value: number) => formatCost(value) ?? "$0";
const names = (keys: Iterable<string>, name: (key: string) => string) => [...new Set([...keys].map(name))].join(", ");

export function isLocal(entry: UsageEntry): boolean {
  return entry.billing === "local" || LOCAL.has(providerOf(entry));
}

function Stat({ label, value, detail, hint }: { label: string; value: string; detail: string; hint?: string | undefined }) {
  return (
    <section className="usage-card usage-stat" aria-label={label}>
      <h3>{label}</h3>
      <p className="usage-stat-value" {...(hint ? tooltipProps(hint, { side: "top" }) : {})}>{value}</p>
      <p className="usage-stat-detail">{detail}</p>
    </section>
  );
}

/**
 * Design 1h's four figures for the period: money paid per token, tokens on
 * plans, threads and the agents they spawned, tokens on local models.
 */
export function UsageStats({ entries, from, weekFrom, threads }: { entries: readonly UsageEntry[]; from: number; weekFrom: number; threads: ReadonlyMap<string, UiSession> }) {
  let spend = 0, week = 0, planTokens = 0, planValue = 0, localTokens = 0;
  const plans = new Set<string>(), locals = new Set<string>(), roots = new Set<string>(), agents = new Set<string>();
  for (const entry of entries) {
    if (entry.day >= weekFrom) week += entry.costUsd;
    if (entry.day < from) continue;
    spend += entry.costUsd;
    if (onPlan(entry)) { planTokens += entry.totalTokens; planValue += entry.apiValueUsd; plans.add(providerOf(entry)); }
    if (isLocal(entry)) { localTokens += entry.totalTokens; locals.add(providerOf(entry)); }
    const key = `${entry.machine ?? ""}\u0000${entry.backend}\u0000${entry.threadId}`;
    (!entry.machine && threads.get(entry.threadId)?.parentThreadId ? agents : roots).add(key);
  }
  const label = (key: string) => providerStackLabel(key, undefined);
  return (
    <div className="usage-stats" aria-label="Totals">
      <Stat label="API spend" value={money(spend)} detail={`${money(week)} last week`} />
      <Stat label="On plans" value={formatTokens(planTokens)} detail={plans.size > 0 ? `tokens · ${names(plans, (key) => PLAN_NAMES[key] ?? label(key))}` : "tokens · no plan used"} hint={planValue > 0 ? `≈ ${money(planValue)} at API prices` : undefined} />
      <Stat label="Threads" value={String(roots.size)} detail={`${agents.size} ${agents.size === 1 ? "agent" : "agents"} spawned`} />
      <Stat label="Local" value={formatTokens(localTokens)} detail={locals.size > 0 ? `tokens on ${names(locals, label)} · $0` : "tokens on local models"} />
    </div>
  );
}

/** A row's figure, one line as the design's: money per token, or a plan's tokens where they weigh more; the other on hover. */
export function Figure({ item, metric }: { item: RankedUsage; metric: UsageMetric }) {
  if (metric === "turns") return <span className="usage-table-value">{item.requests}</span>;
  if (metric === "tokens") return <span className="usage-table-value">{formatTokens(item.totalTokens)} tok</span>;
  const tokens = `${formatTokens(item.totalTokens)} tok`;
  const plan = item.apiValueUsd > item.costUsd;
  const hint = item.apiValueUsd > 0 ? `${plan ? `${money(item.costUsd)} API spend` : tokens} · plans ≈ ${money(item.apiValueUsd)} at API prices` : undefined;
  return <span className="usage-table-value" {...(hint ? tooltipProps(hint, { side: "top" }) : {})}>{plan ? tokens : money(item.costUsd)}</span>;
}

export interface TableRow {
  item: RankedUsage;
  name: string;
  mark: ReactNode;
  title?: string | undefined;
  onOpen?(): void;
}

/** Design 1h's "By provider" and "By project": the name, a bar against the first, threads, the figure. */
export function UsageTable({ id, title, rows, metric, bars = false, counts = true, empty, children }: { id?: string; title: string; rows: readonly TableRow[]; metric: UsageMetric; bars?: boolean; counts?: boolean; empty: string; children?: ReactNode }) {
  const top = Math.max(1e-9, ...rows.map((row) => measure(row.item, metric)));
  return (
    <section className="usage-card usage-table" id={id} aria-label={title} data-counts={counts ? undefined : "false"}>
      <div className="usage-table-head" aria-hidden="true">
        <span>{title}</span>{counts ? <span>threads</span> : null}<span>{metric === "cost" ? "cost" : metric}</span>
      </div>
      {rows.length === 0 ? <p className="usage-note">{empty}</p> : (
        <ol>
          {rows.map((row) => (
            <li key={row.item.key}>
              <span className="usage-table-name">
                {row.mark}
                {row.onOpen ? <button type="button" onClick={row.onOpen} {...(row.title ? tooltipProps(row.title, { side: "top" }) : {})}>{row.name}</button> : <span {...(row.title ? tooltipProps(row.title, { side: "top" }) : {})}>{row.name}</span>}
                {bars ? <i className="usage-table-bar" aria-hidden="true"><i style={{ width: `${(measure(row.item, metric) / top) * 100}%` }} /></i> : null}
              </span>
              {counts ? <span className="usage-table-threads">{row.item.threads}</span> : null}
              <Figure item={row.item} metric={metric} />
            </li>
          ))}
        </ol>
      )}
      {children}
    </section>
  );
}

export function providerRow(item: RankedUsage): TableRow {
  return { item, name: providerStackLabel(item.provider, undefined), mark: <ProviderIconStack modelProvider={item.provider} hint={false} /> };
}

export function projectRow(item: RankedUsage, project: ProjectIconSubject, detail?: string): TableRow {
  return { item, name: project.name, mark: <ProjectIcon project={project} className="usage-project-icon" />, title: detail ? `${project.path} · ${detail}` : project.path };
}

export interface CostliestThread {
  thread: UiSession;
  item: RankedUsage;
  agents: number;
}

/**
 * The Tau thread that used the most in the period, its agents' use counted
 * with it; `ranked` are threads by `rankUsage`.
 */
export function costliestThread(ranked: readonly RankedUsage[], threads: ReadonlyMap<string, UiSession>, metric: UsageMetric): CostliestThread | undefined {
  const roots = new Map<string, CostliestThread>();
  for (const item of ranked) {
    if (item.machine || item.origin !== "tau" || !item.threadId) continue;
    let thread = threads.get(item.threadId);
    for (let depth = 0; thread?.parentThreadId && depth < 8; depth++) thread = threads.get(thread.parentThreadId) ?? thread;
    if (!thread) continue;
    const root = roots.get(thread.id) ?? { thread, item: { ...item, key: thread.id, costUsd: 0, apiValueUsd: 0, totalTokens: 0, requests: 0 }, agents: 0 };
    root.item.costUsd += item.costUsd;
    root.item.apiValueUsd += item.apiValueUsd;
    root.item.totalTokens += item.totalTokens;
    root.item.requests += item.requests;
    if (item.threadId !== thread.id) root.agents += 1;
    roots.set(thread.id, root);
  }
  return [...roots.values()].sort((left, right) => measure(right.item, metric) - measure(left.item, metric))[0];
}
