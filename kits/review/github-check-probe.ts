import type { PullRequestCheck, PullRequestRef } from "./protocol.js";
import type { ProviderTools } from "./provider.js";
import type { FailedCheck } from "./pr-watch-protocol.js";
import { githubCheckStatus } from "./pull-request-json.js";

type Json = Record<string, unknown>;
const record = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const text = (value: unknown): string | undefined => typeof value === "string" && value ? value : undefined;
const rows = (value: unknown): Json[] => Array.isArray(value) ? value.map(record) : [];

/** Answers kept for conditional reads; the oldest is forgotten first. */
const HELD = 200;
const FAILED = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure"]);
const QUEUED = new Set(["queued", "waiting", "pending", "requested"]);

/** What a request's head commit says about its checks, read with `If-None-Match`. */
export interface CheckProbe {
  /** Both answers' ETags: an equal tag means GitHub had nothing new. */
  tag: string;
  /** The commit GitHub read them for. */
  head?: string;
  checks: PullRequestCheck[];
  /** Counted the way a watch counts them. */
  pending: boolean;
  failed: FailedCheck[];
  /** More than one page came back; a change past the first may keep the tag. */
  partial: boolean;
}

interface Answer { etag: string; body: Json }

/** The head of `gh api --include` output: its status code, ETag and body. */
export function parseIncluded(output: string): { status: number; etag?: string; body?: Json } {
  const status = Number(/^HTTP\/\S+ (\d{3})/u.exec(output)?.[1] ?? 0);
  const split = /\r?\n\r?\n/u.exec(output);
  const head = split ? output.slice(0, split.index) : output;
  const etag = /^etag:\s*(.+?)\s*$/imu.exec(head)?.[1];
  const rest = split ? output.slice(split.index + split[0].length).trim() : "";
  return { status, ...(etag ? { etag } : {}), ...(rest ? { body: record(JSON.parse(rest)) } : {}) };
}

function runCheck(run: Json): PullRequestCheck {
  const status = githubCheckStatus({ conclusion: run.conclusion });
  const url = text(run.details_url) ?? text(run.html_url);
  const startedAt = text(run.started_at), completedAt = text(run.completed_at);
  return {
    name: text(run.name) ?? "check", status, ...(url ? { url } : {}),
    ...(startedAt ? { startedAt } : {}), ...(completedAt ? { completedAt } : {}),
    ...(status === "pending" && QUEUED.has(String(run.status)) ? { queued: true } : {}),
  };
}

function statusCheck(entry: Json): PullRequestCheck {
  const url = text(entry.target_url), description = text(entry.description);
  return { name: text(entry.context) ?? "status", status: githubCheckStatus({ state: entry.state }), ...(url ? { url } : {}), ...(description ? { description } : {}) };
}

/** The probe from both answers; failure ids are the ones `readWatchSnapshot` names. */
export function probeOf(tag: string, runsBody: Json, statusBody: Json): CheckProbe {
  const runs = rows(runsBody.check_runs), statuses = rows(statusBody.statuses);
  const head = text(statusBody.sha) ?? text(runs[0]?.head_sha);
  const failed = [
    ...runs.filter((run) => run.status === "completed" && FAILED.has(String(run.conclusion))).map((run) => ({ id: String(run.id), name: text(run.name) ?? "check" })),
    ...statuses.filter((entry) => entry.state === "failure" || entry.state === "error").map((entry) => ({ id: `${text(entry.context) ?? ""} ${text(entry.target_url) ?? ""}`, name: text(entry.context) ?? "status" })),
  ];
  return {
    tag, ...(head ? { head } : {}),
    checks: [...runs.map(runCheck), ...statuses.map(statusCheck)],
    // The combined state reads "pending" while there are no statuses at all, so the rows decide.
    pending: runs.some((run) => run.status !== "completed") || statuses.some((entry) => entry.state === "pending"),
    failed,
    partial: Number(runsBody.total_count ?? 0) > runs.length || Number(statusBody.total_count ?? 0) > statuses.length,
  };
}

/**
 * Reads a request's check runs and commit statuses through `gh api` with the
 * ETag of the last answer. GitHub counts a 304 against no rate limit, so this
 * can ask every few seconds where a GraphQL read could not. `refs/pull/N/head`
 * follows a push, and names a fork's head through the base repository.
 */
export function createCheckProbe(): (cli: ProviderTools["cli"], ref: PullRequestRef, identity?: string) => Promise<CheckProbe> {
  const held = new Map<string, Answer>();
  const get = async (cli: ProviderTools["cli"], host: string, path: string, identity: string): Promise<Answer> => {
    const key = `${identity}\0${host}\0${path}`;
    const known = held.get(key);
    const output = await cli("github", { args: ["api", "--hostname", host, "--include", ...(known ? ["-H", `If-None-Match: ${known.etag}`] : []), path] }, "Reading the checks", {
      host,
      // gh exits 1 for a 304; the answer is the one already held.
      acceptFailure: (stdout, exitCode) => exitCode === 1 && Boolean(known) && /^HTTP\/\S+ 304\b/u.test(stdout),
    });
    const answer = parseIncluded(output);
    held.delete(key);
    const next = answer.status === 304 && known ? known : { etag: answer.etag ?? "", body: answer.body ?? {} };
    if (next.etag) held.set(key, next);
    while (held.size > HELD) held.delete(held.keys().next().value!);
    return next;
  };
  return async (cli, ref, identity = "") => {
    const at = `repos/${ref.repo}/commits/refs/pull/${ref.number}/head`;
    const [runs, status] = await Promise.all([get(cli, ref.host, `${at}/check-runs?per_page=100`, identity), get(cli, ref.host, `${at}/status?per_page=100`, identity)]);
    // Without an ETag nothing tells two answers apart; an empty tag never matches.
    return probeOf(runs.etag && status.etag ? `${runs.etag} ${status.etag}` : "", runs.body, status.body);
  };
}
