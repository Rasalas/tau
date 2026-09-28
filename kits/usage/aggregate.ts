import type { PiScan } from "./pi-sessions.js";
import {
  PI_BACKEND,
  type BackendUsageAnswer,
  type BackendUsageSource,
  type BackendUsageTurn,
  type UsageBilling,
  type UsageRow,
  type UsageShare,
  type UsageSourceReport,
  type UsageSummary,
  type UsageTotals,
} from "./protocol.js";

/** A backend kit's answer, or why there was none. */
export interface BackendScan {
  source: BackendUsageSource;
  answer?: BackendUsageAnswer;
  error?: string;
}

export interface UsageScan {
  scannedAt: number;
  sessionsDir: string;
  pi: PiScan;
  backends: BackendScan[];
}

export interface SummarizeOptions {
  since?: number;
  daily?: boolean;
  timeZone?: string;
  /** A project's name; the folder's name when this says nothing. */
  nameOf?(cwd: string): string | undefined;
}

export function emptyShare(): UsageShare {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, requests: 0, apiValueUsd: 0 };
}

export function emptyTotals(): UsageTotals {
  return { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0, threads: 0, subscription: emptyShare() };
}

function folderName(cwd: string): string {
  return cwd.split(/[\\/]/u).filter(Boolean).pop() ?? (cwd || "unknown project");
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** `provider/id` as Pi names a model; the first slash splits, an id may carry more. */
export function splitModel(model: string): { provider?: string; modelId: string } {
  const slash = model.indexOf("/");
  return slash > 0 ? { provider: model.slice(0, slash), modelId: model.slice(slash + 1) } : { modelId: model };
}

type RowKey = { day?: string; backend: string; backendLabel: string; cwd: string; model: string; provider?: string; modelId?: string; billing?: UsageBilling };

class Rows {
  private readonly rows = new Map<string, UsageRow & { threadIds: Set<string> }>();

  constructor(private readonly nameOf: (cwd: string) => string | undefined) {}

  row(key: RowKey) {
    const id = `${key.backend}\u0000${key.cwd}\u0000${key.model}\u0000${key.billing ?? ""}\u0000${key.day ?? ""}`;
    let row = this.rows.get(id);
    if (!row) {
      row = {
        ...(key.day ? { day: key.day } : {}),
        backend: key.backend,
        backendLabel: key.backendLabel,
        cwd: key.cwd,
        projectName: this.nameOf(key.cwd) ?? folderName(key.cwd),
        model: key.model,
        ...(key.provider ? { provider: key.provider } : {}),
        ...(key.modelId ? { modelId: key.modelId } : {}),
        ...(key.billing ? { billing: key.billing } : {}),
        requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0, apiValueUsd: 0, threads: 0,
        threadIds: new Set(),
      };
      this.rows.set(id, row);
    }
    return row;
  }

  finish(): { rows: UsageRow[]; threads: number } {
    const threads = new Set<string>();
    const rows: UsageRow[] = [];
    for (const { threadIds, ...row } of this.rows.values()) {
      row.threads = threadIds.size;
      for (const id of threadIds) threads.add(`${row.backend}\u0000${id}`);
      rows.push(row);
    }
    return { rows, threads: threads.size };
  }
}

/** Totals over rows; a subscription's rows add their tokens to both, their value only to `subscription`. */
export function totalsOf(rows: readonly UsageRow[], threads: number): UsageTotals {
  const totals = emptyTotals();
  totals.threads = threads;
  for (const row of rows) {
    totals.requests += row.requests;
    totals.inputTokens += row.inputTokens;
    totals.outputTokens += row.outputTokens;
    totals.cacheReadTokens += row.cacheReadTokens;
    totals.cacheWriteTokens += row.cacheWriteTokens;
    totals.totalTokens += row.totalTokens;
    totals.costUsd += row.costUsd;
    if (row.billing !== "subscription") continue;
    const share = totals.subscription;
    share.inputTokens += row.inputTokens;
    share.outputTokens += row.outputTokens;
    share.cacheReadTokens += row.cacheReadTokens;
    share.cacheWriteTokens += row.cacheWriteTokens;
    share.totalTokens += row.totalTokens;
    share.requests += row.requests;
    share.apiValueUsd += row.apiValueUsd;
  }
  return totals;
}

export function sortRows(rows: UsageRow[]): UsageRow[] {
  return rows.sort((left, right) => (right.costUsd + right.apiValueUsd) - (left.costUsd + left.apiValueUsd) || right.totalTokens - left.totalTokens || left.projectName.localeCompare(right.projectName));
}

/** A row's price as core worked it out. */
export interface RowPrice {
  billing?: UsageBilling;
  costUsd: number;
  apiValueUsd: number;
  source: NonNullable<UsageRow["priceSource"]>;
}

/** Without core's prices: the runtime's own figure, a subscription's as its value. */
export function runtimePrice(row: UsageRow): RowPrice {
  return row.billing === "subscription"
    ? { billing: row.billing, costUsd: 0, apiValueUsd: row.costUsd, source: row.costUsd > 0 ? "runtime" : "none" }
    : { ...(row.billing ? { billing: row.billing } : {}), costUsd: row.costUsd, apiValueUsd: 0, source: row.costUsd > 0 ? "runtime" : "none" };
}

/** The summary with each row priced; `prices` lines up with `summary.rows`. */
export function applyPrices(summary: UsageSummary, prices: ReadonlyArray<RowPrice | undefined>): UsageSummary {
  const rows = summary.rows.map((row, index) => {
    const price = prices[index] ?? runtimePrice(row);
    const { billing: _billing, ...rest } = row;
    return { ...rest, ...(price.billing ? { billing: price.billing } : {}), costUsd: price.costUsd, apiValueUsd: price.apiValueUsd, priceSource: price.source };
  });
  return { ...summary, rows: sortRows(rows), totals: totalsOf(rows, summary.totals.threads) };
}

function piReport(scan: UsageScan, threads: number): UsageSourceReport {
  const base = { backend: PI_BACKEND, label: "Pi", dating: "message" as const };
  if (!scan.pi.found) return { ...base, status: "empty", detail: `No Pi session directory at ${scan.sessionsDir}.` };
  if (scan.pi.sessions.length === 0 && scan.pi.failed === 0) return { ...base, status: "empty", detail: `No Pi session files in ${scan.sessionsDir} yet.` };
  const skipped = scan.pi.sessions.reduce((sum, session) => sum + session.skippedLines, 0);
  const parts = [`Read ${plural(scan.pi.sessions.length, "session file")} in ${scan.sessionsDir}`, `${plural(threads, "thread")} with usage in this period`];
  if (scan.pi.failed > 0) parts.push(`${plural(scan.pi.failed, "file")} could not be read`);
  if (skipped > 0) parts.push(`${plural(skipped, "unreadable line")} skipped`);
  return { ...base, status: "ok", detail: `${parts.join("; ")}.` };
}

function backendReport(scan: BackendScan, threads: number): UsageSourceReport {
  const byTurn = (scan.answer?.threads ?? []).some((thread) => thread.turns);
  const base = { backend: scan.source.backend, label: scan.source.label, dating: byTurn ? "turn" as const : "thread" as const };
  if (!scan.answer) return { ...base, status: "unavailable", detail: `Not available: ${scan.error ?? `${scan.source.label} did not answer`}.` };
  const all = scan.answer.threads.length;
  if (all === 0) return { ...base, status: "empty", detail: `No ${scan.source.label} threads yet.` };
  const without = scan.answer.threads.filter((thread) => !thread.usage).length;
  const parts = [`${plural(all, "thread")} on record`, `${plural(threads, "thread")} with usage in this period`];
  if (without > 0) parts.push(`${plural(without, "thread")} kept no usage`);
  const lumped = scan.answer.threads.filter((thread) => thread.usage && !thread.turns).length;
  const dating = lumped === 0 ? "Each turn is dated on its own." : byTurn
    ? `Each turn is dated on its own; ${plural(lumped, "older thread")} from before turns were kept ${lumped === 1 ? "is" : "are"} dated by ${lumped === 1 ? "its" : "their"} last activity.`
    : "Each thread's total is dated by its last activity.";
  return { ...base, status: "ok", detail: `${parts.join("; ")}. ${dating}` };
}

/**
 * Sums a scan for one period, unpriced: costs are the runtimes' own until
 * `applyPrices` sets core's. A Pi response copied into a fork is counted once,
 * for the session it was first written to; a backend turn counts when it
 * falls inside the period, and a thread kept before turns were counts whole
 * when its last activity does.
 */
export function summarize(scan: UsageScan, options: SummarizeOptions = {}): UsageSummary {
  const since = options.since;
  const dates = options.daily ? new Intl.DateTimeFormat("en-CA", { timeZone: options.timeZone ?? "UTC", year: "numeric", month: "2-digit", day: "2-digit" }) : undefined;
  const dayOf = (at: number) => dates ? { day: dates.format(at) } : {};
  const rows = new Rows(options.nameOf ?? (() => undefined));
  const inPeriod = (at: number | undefined) => since === undefined || (at !== undefined && at >= since);

  const seen = new Set<string>();
  const piThreads = new Set<string>();
  const sessions = [...scan.pi.sessions].sort((left, right) => left.createdAt - right.createdAt || left.path.localeCompare(right.path));
  for (const session of sessions) {
    for (const record of session.records) {
      if (seen.has(record.key)) continue;
      seen.add(record.key);
      if (!inPeriod(record.at) || (options.daily && record.at === undefined)) continue;
      const row = rows.row({ ...dayOf(record.at ?? 0), backend: PI_BACKEND, backendLabel: "Pi", cwd: session.cwd, model: record.model, ...splitModel(record.model) });
      row.requests += record.requests;
      row.inputTokens += record.input;
      row.outputTokens += record.output;
      row.cacheReadTokens += record.cacheRead;
      row.cacheWriteTokens += record.cacheWrite;
      row.totalTokens += record.total;
      row.costUsd += record.cost;
      row.threadIds.add(session.sessionId);
      piThreads.add(session.sessionId);
    }
  }

  const reports: UsageSourceReport[] = [];
  for (const backend of scan.backends) {
    let counted = 0;
    for (const thread of backend.answer?.threads ?? []) {
      const turns: BackendUsageTurn[] = thread.turns ?? (thread.usage ? [{ ...thread.usage, at: thread.updatedAt }] : []);
      let any = false;
      for (const turn of turns) {
        if (!inPeriod(turn.at)) continue;
        const model = turn.model ?? thread.model ?? "default model";
        const row = rows.row({
          ...dayOf(turn.at),
          backend: backend.source.backend,
          backendLabel: backend.source.label,
          cwd: thread.cwd,
          model,
          ...(turn.provider ? { provider: turn.provider } : {}),
          modelId: model,
          ...(turn.billing ? { billing: turn.billing } : {}),
        });
        row.requests += turn.turns;
        row.inputTokens += turn.inputTokens;
        row.outputTokens += turn.outputTokens;
        row.cacheReadTokens += turn.cacheReadTokens;
        row.cacheWriteTokens += turn.cacheWriteTokens;
        row.totalTokens += turn.totalTokens;
        row.costUsd += turn.costUsd;
        row.threadIds.add(thread.threadId);
        any = true;
      }
      if (any) counted += 1;
    }
    reports.push(backendReport(backend, counted));
  }

  const { rows: list, threads } = rows.finish();
  const priced = list.map(runtimePrice);
  return applyPrices({
    ...(since === undefined ? {} : { since }),
    scannedAt: scan.scannedAt,
    totals: { ...emptyTotals(), threads },
    rows: list,
    sources: [piReport(scan, piThreads.size), ...reports],
  }, priced);
}
