import type { PullRequestCheck } from "./protocol.js";

/** Successful earlier runs a usual duration is the median of. */
export const HISTORY_RUNS = 5;

export type JobState = "queued" | "running" | "passed" | "failed" | "cancelled" | "skipped" | "waiting";

/** One job of a pipeline as a circle draws it. */
export interface PipelineJob {
  name: string;
  state: JobState;
  startedAt?: number;
  endedAt?: number;
  /** The usual duration: the median of recent successful runs. */
  expectedMs?: number;
  url?: string;
}

/** A workflow run, its jobs in stages left to right. */
export interface Pipeline {
  name: string;
  stages: PipelineJob[][];
}

/** A job as its workflow file declares it. */
export interface WorkflowJob {
  id: string;
  name?: string;
  needs: string[];
}

/** What the host learned about one workflow run: its file's jobs and their usual durations by name. */
export interface RunFacts {
  jobs?: WorkflowJob[];
  expected: Record<string, number>;
}

/** Facts by run id. */
export type PipelineFacts = Record<string, RunFacts>;

const unquote = (value: string) => value.trim().replace(/^(["'])(.*)\1$/u, "$2").trim();

/**
 * The `jobs:` of a GitHub Actions workflow file: ids, names and needs. Reads
 * only the shapes those keys take in practice; anything else is skipped.
 */
export function workflowJobs(source: string): WorkflowJob[] {
  const jobs: WorkflowJob[] = [];
  let inJobs = false;
  let jobIndent = -1;
  let keyIndent = -1;
  let current: WorkflowJob | undefined;
  let listing = false;
  for (const raw of source.split(/\r?\n/u)) {
    const line = raw.replace(/\s+#(?=[^"']*$).*$/u, "");
    const body = line.trim();
    if (!body || body.startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      inJobs = body === "jobs:";
      current = undefined;
      continue;
    }
    if (!inJobs) continue;
    if (jobIndent < 0) jobIndent = indent;
    if (indent <= jobIndent) {
      const id = /^["']?([\w-]+)["']?:$/u.exec(body)?.[1];
      current = id ? { id, needs: [] } : undefined;
      if (current) jobs.push(current);
      keyIndent = -1;
      listing = false;
      continue;
    }
    if (!current) continue;
    if (keyIndent < 0) keyIndent = indent;
    if (indent === keyIndent) {
      const [, key, value = ""] = /^(name|needs):\s*(.*)$/u.exec(body) ?? [];
      listing = key === "needs" && !value;
      if (key === "name" && value && !/^[|>]/u.test(value)) current.name = unquote(value);
      if (key === "needs" && value) current.needs = value.replace(/^\[|\]$/gu, "").split(",").map(unquote).filter(Boolean);
    } else if (listing && body.startsWith("- ")) current.needs.push(unquote(body.slice(2)));
  }
  return jobs;
}

/** Each job's stage: none needed is 0, otherwise one after the latest it needs. */
export function stageLevels(jobs: readonly WorkflowJob[]): Map<string, number> {
  const byId = new Map(jobs.map((job) => [job.id, job]));
  const levels = new Map<string, number>();
  const visit = (id: string, path: Set<string>): number => {
    const known = levels.get(id);
    if (known !== undefined) return known;
    if (path.has(id)) return 0;
    path.add(id);
    const needs = byId.get(id)?.needs.filter((need) => byId.has(need)) ?? [];
    const level = needs.length ? Math.max(...needs.map((need) => visit(need, path))) + 1 : 0;
    levels.set(id, level);
    return level;
  };
  for (const job of jobs) visit(job.id, new Set());
  return levels;
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** The declared job a check run belongs to: by name, a matrix's `name (…)`, a called workflow's `name / …`, or a templated name. */
export function jobFor(check: string, jobs: readonly WorkflowJob[]): WorkflowJob | undefined {
  const label = (job: WorkflowJob) => job.name ?? job.id;
  return jobs.find((job) => label(job) === check)
    ?? jobs.find((job) => check.startsWith(`${label(job)} (`) || check.startsWith(`${label(job)} / `))
    ?? jobs.find((job) => label(job).includes("${{") && new RegExp(`^${label(job).split(/\$\{\{.*?\}\}/u).map(escape).join(".*")}( \\(.*\\)| / .*)?$`, "u").test(check));
}

export function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** A GitHub Actions run id from a check's link. */
export const runIdOf = (url: string | undefined): string | undefined => url ? /\/actions\/runs\/(\d+)/u.exec(url)?.[1] : undefined;

const time = (iso: string | undefined): number | undefined => {
  const at = iso ? Date.parse(iso) : NaN;
  // GitHub reports a time not yet reached as year 1.
  return at > 946_684_800_000 ? at : undefined;
};

function checkState(check: PullRequestCheck): JobState {
  switch (check.status) {
    case "pending": return check.queued ? "queued" : "running";
    case "action-required": return "waiting";
    case "neutral": return "skipped";
    default: return check.status;
  }
}

/**
 * The checks as pipelines, one per workflow: its jobs in stages by `needs`
 * where the workflow file was read, in one stage otherwise. Checks outside
 * any workflow form a last pipeline of their own.
 */
export function checksPipelines(checks: readonly PullRequestCheck[], facts: PipelineFacts = {}): Pipeline[] {
  const groups = new Map<string, PullRequestCheck[]>();
  for (const check of checks) {
    const key = check.workflow ?? "";
    groups.set(key, [...groups.get(key) ?? [], check]);
  }
  const ordered = [...groups].sort(([a], [b]) => Number(!a) - Number(!b));
  return ordered.map(([workflow, group]) => {
    const known = group.map((check) => facts[runIdOf(check.url) ?? ""]).find(Boolean);
    const declared = known?.jobs ?? [];
    const levels = stageLevels(declared);
    const stages: PipelineJob[][] = [];
    for (const check of group) {
      const name = workflow && check.name.startsWith(`${workflow} / `) ? check.name.slice(workflow.length + 3) : check.name;
      const startedAt = time(check.startedAt);
      const endedAt = time(check.completedAt);
      const expectedMs = known?.expected[name];
      const job: PipelineJob = {
        name, state: checkState(check),
        ...(startedAt ? { startedAt } : {}), ...(endedAt ? { endedAt } : {}), ...(expectedMs ? { expectedMs } : {}), ...(check.url ? { url: check.url } : {}),
      };
      const level = levels.get(jobFor(name, declared)?.id ?? "") ?? 0;
      (stages[level] ??= []).push(job);
    }
    return { name: workflow || "Other checks", stages: stages.filter(Boolean) };
  });
}

/** A local check's run, as Project Scripts reports it. */
export interface ScriptRunLike {
  name: string;
  status: "running" | "succeeded" | "failed" | "stopped";
  at: number;
  endedAt?: number;
  expectedMs?: number;
}

const RUN_STATES = { running: "running", succeeded: "passed", failed: "failed", stopped: "cancelled" } as const;

/** A worktree's script runs as one stage: scripts declare no order among them. */
export function runsPipeline(runs: readonly ScriptRunLike[]): Pipeline {
  return {
    name: "Project scripts",
    stages: [runs.map((run) => ({
      name: run.name, state: RUN_STATES[run.status], startedAt: run.at,
      ...(run.endedAt ? { endedAt: run.endedAt } : {}), ...(run.expectedMs ? { expectedMs: run.expectedMs } : {}),
    }))],
  };
}

const DONE = new Set<JobState>(["passed", "failed", "cancelled", "skipped"]);

/** How far a job is, 0 to 1; undefined for a running job without a usual duration to measure against. */
export function jobProgress(job: PipelineJob, now: number): number | undefined {
  if (DONE.has(job.state)) return 1;
  if (job.state !== "running") return 0;
  if (!job.startedAt || !job.expectedMs) return undefined;
  return Math.min(1, Math.max(0, (now - job.startedAt) / job.expectedMs));
}

export const isActive = (job: PipelineJob) => job.state === "running" || job.state === "queued" || job.state === "waiting";

const STAGE_ORDER: JobState[] = ["failed", "running", "waiting", "queued", "cancelled"];

/** A stage as one state, the worst news winning: failed, running, pending, cancelled; skipped only when every job was. */
export function stageState(jobs: readonly PipelineJob[]): JobState {
  return STAGE_ORDER.find((state) => jobs.some((job) => job.state === state))
    ?? (jobs.every((job) => job.state === "skipped") ? "skipped" : "passed");
}

/** A stage's progress, its jobs' mean; undefined while nothing in it has an estimate to show. */
export function stageProgress(jobs: readonly PipelineJob[], now: number): number | undefined {
  const parts = jobs.map((job) => jobProgress(job, now));
  const sum = parts.reduce<number>((total, part) => total + (part ?? 0), 0);
  return parts.includes(undefined) && !sum ? undefined : sum / jobs.length;
}

/** `45s`, `3m 12s`, `1h 4m`. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export const STATE_WORDS: Record<JobState, string> = {
  queued: "Queued", running: "Running", passed: "Passed", failed: "Failed", cancelled: "Cancelled", skipped: "Skipped", waiting: "Waiting for approval",
};

/** "Running · 2m 10s of about 4m 0s", "Passed · 3m 2s", "Running · no usual time yet". */
export function jobTiming(job: PipelineJob, now: number): string {
  const word = STATE_WORDS[job.state];
  if (job.state === "running") {
    if (!job.startedAt) return word;
    const elapsed = formatDuration(now - job.startedAt);
    if (!job.expectedMs) return `${word} · ${elapsed}, no usual time yet`;
    return `${word} · ${elapsed} of about ${formatDuration(job.expectedMs)}${now - job.startedAt > job.expectedMs ? ", longer than usual" : ""}`;
  }
  if (job.startedAt && job.endedAt && job.state !== "skipped") return `${word} · ${formatDuration(job.endedAt - job.startedAt)}`;
  return job.state === "queued" && job.expectedMs ? `${word} · usually ${formatDuration(job.expectedMs)}` : word;
}
