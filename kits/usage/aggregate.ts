import type { PiScan } from "./pi-sessions.js";
import {
  PI_BACKEND,
  type BackendUsageAnswer,
  type BackendUsageSource,
  type UsageRow,
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
  /** A project's name; the folder's name when this says nothing. */
  nameOf?(cwd: string): string | undefined;
}

export function emptyTotals(): UsageTotals {
  return { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0, threads: 0 };
}

function folderName(cwd: string): string {
  return cwd.split(/[\\/]/u).filter(Boolean).pop() ?? (cwd || "unknown project");
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

class Rows {
  private readonly rows = new Map<string, UsageRow & { threadIds: Set<string> }>();

  constructor(private readonly nameOf: (cwd: string) => string | undefined) {}

  row(backend: string, backendLabel: string, cwd: string, model: string) {
    const key = `${backend}\u0000${cwd}\u0000${model}`;
    let row = this.rows.get(key);
    if (!row) {
      row = { ...emptyTotals(), backend, backendLabel, cwd, projectName: this.nameOf(cwd) ?? folderName(cwd), model, threadIds: new Set() };
      this.rows.set(key, row);
    }
    return row;
  }

  finish(): { rows: UsageRow[]; totals: UsageTotals } {
    const totals = emptyTotals();
    const threads = new Set<string>();
    const rows: UsageRow[] = [];
    for (const { threadIds, ...row } of this.rows.values()) {
      row.threads = threadIds.size;
      for (const id of threadIds) threads.add(`${row.backend}\u0000${id}`);
      totals.requests += row.requests;
      totals.inputTokens += row.inputTokens;
      totals.outputTokens += row.outputTokens;
      totals.cacheReadTokens += row.cacheReadTokens;
      totals.cacheWriteTokens += row.cacheWriteTokens;
      totals.totalTokens += row.totalTokens;
      totals.costUsd += row.costUsd;
      rows.push(row);
    }
    totals.threads = threads.size;
    rows.sort((left, right) => right.costUsd - left.costUsd || right.totalTokens - left.totalTokens || left.projectName.localeCompare(right.projectName));
    return { rows, totals };
  }
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
  const base = { backend: scan.source.backend, label: scan.source.label, dating: "thread" as const };
  if (!scan.answer) return { ...base, status: "unavailable", detail: `Not available: ${scan.error ?? `${scan.source.label} did not answer`}.` };
  const all = scan.answer.threads.length;
  if (all === 0) return { ...base, status: "empty", detail: `No ${scan.source.label} threads yet.` };
  const without = scan.answer.threads.filter((thread) => !thread.usage).length;
  const parts = [`${plural(all, "thread")} on record`, `${plural(threads, "thread")} with usage in this period`];
  if (without > 0) parts.push(`${plural(without, "thread")} kept no usage`);
  return { ...base, status: "ok", detail: `${parts.join("; ")}. Each thread's total is dated by its last activity.` };
}

/**
 * Sums a scan for one period. A Pi response copied into a fork is counted once,
 * for the session it was first written to; a backend thread counts whole when
 * its last activity falls inside the period, because its kit keeps one total.
 */
export function summarize(scan: UsageScan, options: SummarizeOptions = {}): UsageSummary {
  const since = options.since;
  const rows = new Rows(options.nameOf ?? (() => undefined));
  const inPeriod = (at: number | undefined) => since === undefined || (at !== undefined && at >= since);

  const seen = new Set<string>();
  const piThreads = new Set<string>();
  const sessions = [...scan.pi.sessions].sort((left, right) => left.createdAt - right.createdAt || left.path.localeCompare(right.path));
  for (const session of sessions) {
    for (const record of session.records) {
      if (seen.has(record.key)) continue;
      seen.add(record.key);
      if (!inPeriod(record.at)) continue;
      const row = rows.row(PI_BACKEND, "Pi", session.cwd, record.model);
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
      if (!thread.usage || !inPeriod(thread.updatedAt)) continue;
      const row = rows.row(backend.source.backend, backend.source.label, thread.cwd, thread.model ?? "default model");
      row.requests += thread.usage.turns;
      row.inputTokens += thread.usage.inputTokens;
      row.outputTokens += thread.usage.outputTokens;
      row.cacheReadTokens += thread.usage.cacheReadTokens;
      row.cacheWriteTokens += thread.usage.cacheWriteTokens;
      row.totalTokens += thread.usage.totalTokens;
      row.costUsd += thread.usage.costUsd;
      row.threadIds.add(thread.threadId);
      counted += 1;
    }
    reports.push(backendReport(backend, counted));
  }

  const { rows: list, totals } = rows.finish();
  return {
    ...(since === undefined ? {} : { since }),
    scannedAt: scan.scannedAt,
    totals,
    rows: list,
    sources: [piReport(scan, piThreads.size), ...reports],
  };
}
