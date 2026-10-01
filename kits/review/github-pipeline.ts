import type { PullRequestRef } from "./protocol.js";
import type { ProviderTools } from "./provider.js";
import { HISTORY_RUNS, median, workflowJobs, type PipelineFacts, type RunFacts, type WorkflowJob } from "./pipeline.js";

type Json = Record<string, unknown>;
const record = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const text = (value: unknown): string | undefined => typeof value === "string" && value ? value : undefined;
const rows = (value: unknown): Json[] => Array.isArray(value) ? value.map(record) : [];

/** Usual durations are read again after this long. */
const HISTORY_TTL_MS = 6 * 3_600_000;
/** Runs one ask reads at most. */
const MAX_RUNS = 10;
const LIMIT = 200;
const JOBS_BUFFER = 16 * 1024 * 1024;

interface RunMeta { workflowId: string; path: string; sha: string }

/** A bounded map of reads; a failed read is not kept. */
function memo<T>(now: () => number, ttl = Infinity) {
  const held = new Map<string, { at: number; read: Promise<T> }>();
  return (key: string, read: () => Promise<T>): Promise<T> => {
    const known = held.get(key);
    if (known && now() - known.at < ttl) return known.read;
    const next = read();
    held.delete(key);
    held.set(key, { at: now(), read: next });
    next.catch(() => { if (held.get(key)?.read === next) held.delete(key); });
    while (held.size > LIMIT) held.delete(held.keys().next().value!);
    return next;
  };
}

/** Usual job durations by name from the jobs of successful runs. */
export function usualDurations(jobLists: readonly unknown[]): Record<string, number> {
  const samples = new Map<string, number[]>();
  for (const list of jobLists) {
    for (const job of rows(record(list).jobs)) {
      const name = text(job.name);
      const took = Date.parse(text(job.completed_at) ?? "") - Date.parse(text(job.started_at) ?? "");
      if (!name || job.conclusion !== "success" || !(took > 0)) continue;
      samples.set(name, [...samples.get(name) ?? [], took]);
    }
  }
  return Object.fromEntries([...samples].map(([name, values]) => [name, median(values)!]));
}

/**
 * The pipeline facts of a request's workflow runs, through `gh api`: each
 * run's workflow file (its jobs and `needs`, at the run's commit) and the
 * usual duration of each job, the median of the last successful runs of the
 * same workflow on the default branch. Everything is cached; a run's file
 * never changes, the durations are read again after a few hours.
 * With `names` (run id → workflow) the files come from the default branch: a list costs a few reads per repository.
 */
export function createGitHubPipelines(tools: ProviderTools): (ref: PullRequestRef, runIds: readonly string[], names?: Record<string, string>) => Promise<PipelineFacts> {
  const runs = memo<RunMeta>(tools.now);
  const files = memo<WorkflowJob[]>(tools.now);
  const branches = memo<string>(tools.now, HISTORY_TTL_MS);
  const history = memo<Record<string, number>>(tools.now, HISTORY_TTL_MS);
  const workflows = memo<Json[]>(tools.now, HISTORY_TTL_MS);
  const heads = memo<WorkflowJob[]>(tools.now, HISTORY_TTL_MS);

  return async (ref, runIds, names) => {
    const api = async (path: string, action: string, maxBuffer?: number): Promise<Json> =>
      record(JSON.parse(await tools.cli("github", { args: ["api", "--hostname", ref.host, `repos/${ref.repo}/${path}`] }, action, { host: ref.host, ...(maxBuffer ? { maxBuffer } : {}) })));
    const repo = `${ref.host}/${ref.repo}`;
    const branch = () => branches(repo, async () => text(record(JSON.parse(await tools.cli("github", { args: ["api", "--hostname", ref.host, `repos/${ref.repo}`] }, "Reading the repository", { host: ref.host }))).default_branch) ?? "main");

    const file = (path: string, at: string, cache = files) => path && at ? cache(`${repo}@${at}:${path}`, async () => {
      const raw = await api(`contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(at)}`, "Reading a workflow file");
      return workflowJobs(Buffer.from(text(raw.content) ?? "", "base64").toString("utf8"));
    }).catch(() => undefined) : undefined;
    const usual = async (workflowId: string): Promise<Record<string, number>> => workflowId ? history(`${repo}:${workflowId}`, async () => {
      const listed = await api(`actions/workflows/${workflowId}/runs?branch=${encodeURIComponent(await branch())}&status=success&exclude_pull_requests=true&per_page=${HISTORY_RUNS}`, "Reading earlier workflow runs");
      const ids = rows(listed.workflow_runs).map((entry) => entry.id).filter((value) => typeof value === "number").slice(0, HISTORY_RUNS);
      return usualDurations(await Promise.all(ids.map((past) => api(`actions/runs/${past}/jobs?per_page=100`, "Reading earlier jobs", JOBS_BUFFER))));
    }).catch(() => ({})) : {};
    const answer = async (jobs: Promise<WorkflowJob[] | undefined> | undefined, durations: Promise<Record<string, number>>): Promise<RunFacts> => {
      const [declared, expected] = await Promise.all([jobs, durations]);
      return { ...(declared?.length ? { jobs: declared } : {}), expected };
    };

    const facts = async (id: string): Promise<RunFacts> => {
      const name = names?.[id];
      if (name) {
        const all = await workflows(repo, async () => rows((await api("actions/workflows?per_page=100", "Reading the workflows")).workflows));
        const found = all.find((entry) => entry.name === name);
        if (!found) throw new Error(`No workflow named ${name}`);
        return answer(file(text(found.path) ?? "", await branch(), heads), usual(String(found.id ?? "")));
      }
      const run = await runs(`${repo}#${id}`, async () => {
        const raw = await api(`actions/runs/${id}`, "Reading a workflow run");
        return { workflowId: String(raw.workflow_id ?? ""), path: text(raw.path)?.split("@")[0] ?? "", sha: text(raw.head_sha) ?? "" };
      });
      return answer(file(run.path, run.sha), usual(run.workflowId));
    };

    const ids = [...new Set(runIds)].filter((id) => /^\d+$/u.test(id)).slice(0, MAX_RUNS);
    const answers = await Promise.all(ids.map((id) => facts(id).then((found) => [id, found] as const, () => undefined)));
    return Object.fromEntries(answers.filter((entry) => entry !== undefined));
  };
}
