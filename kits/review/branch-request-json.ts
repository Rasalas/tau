import type { UiReviewRequestChecks } from "tau/host-extension";
import type { AutoMergeState, MergeMethod, ReviewRequest } from "./protocol.js";

/*
 * A checkout's own request as `gh pr view` and `glab mr view` report it for
 * the branch: the rail row's mark, the Changes section and the branch diff's
 * base all read this shape.
 */

/** What `gh pr view` is asked for the branch's request. */
export const GITHUB_BRANCH_FIELDS = "number,title,url,baseRefName,headRefName,state,isDraft,statusCheckRollup,body,autoMergeRequest";

const asNumber = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const asString = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim() : undefined;
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};

const PASSED = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const FAILED = new Set(["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"]);

/** `statusCheckRollup` mixes check runs (status + conclusion) and commit statuses (state). */
export function summarizeGitHubChecks(rollup: unknown): UiReviewRequestChecks | undefined {
  if (!Array.isArray(rollup) || rollup.length === 0) return undefined;
  const checks = { passed: 0, failed: 0, pending: 0, total: rollup.length };
  for (const entry of rollup.map(record)) {
    const outcome = (asString(entry.conclusion) ?? asString(entry.state) ?? "").toUpperCase();
    if (PASSED.has(outcome)) checks.passed += 1;
    else if (FAILED.has(outcome)) checks.failed += 1;
    else checks.pending += 1;
  }
  return checks;
}

/** GitLab reports one pipeline per request rather than a list of checks. */
export function summarizeGitLabPipeline(pipeline: unknown): UiReviewRequestChecks | undefined {
  const status = asString(record(pipeline).status)?.toLowerCase();
  if (!status) return undefined;
  if (status === "success" || status === "skipped") return { passed: 1, failed: 0, pending: 0, total: 1 };
  if (status === "failed" || status === "canceled") return { passed: 0, failed: 1, pending: 0, total: 1 };
  return { passed: 0, failed: 0, pending: 1, total: 1 };
}

function requestState(value: string | undefined): ReviewRequest["state"] {
  const state = value?.toLowerCase();
  if (state === "open" || state === "opened") return "open";
  if (state === "merged") return "merged";
  if (state === "closed" || state === "locked") return "closed";
  return undefined;
}

/** The optional status fields, without keys for what the tool did not say. */
function statusFields(state: string | undefined, draft: unknown, checks: UiReviewRequestChecks | undefined, body: unknown): Partial<ReviewRequest> {
  const parsedState = requestState(state);
  const text = typeof body === "string" ? body : undefined;
  return {
    ...(parsedState ? { state: parsedState } : {}),
    ...(typeof draft === "boolean" ? { draft } : {}),
    ...(checks ? { checks } : {}),
    ...(text !== undefined ? { body: text } : {}),
  };
}

/** GitHub's `autoMergeRequest`: null when nothing is armed, else the method it will use. */
export function githubAutoMerge(value: unknown): AutoMergeState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const method = asString(record(value).mergeMethod)?.toLowerCase();
  return method === "squash" || method === "merge" || method === "rebase" ? { method: method as MergeMethod } : {};
}

/** GitLab calls it `merge_when_pipeline_succeeds`, newer versions `auto_merge_enabled` as well. */
export function gitlabAutoMerge(raw: Record<string, unknown>): AutoMergeState | undefined {
  if (raw.merge_when_pipeline_succeeds !== true && raw.auto_merge_enabled !== true) return undefined;
  return raw.squash === true || raw.squash_on_merge === true ? { method: "squash" } : {};
}

/** `gh pr view --json …` for the checkout's branch. */
export function parseGitHubBranchRequest(output: string): ReviewRequest | undefined {
  const raw = record(JSON.parse(output));
  const number = asNumber(raw.number);
  const baseRef = asString(raw.baseRefName);
  const url = asString(raw.url);
  if (number === undefined || !baseRef || !url) return undefined;
  const autoMerge = githubAutoMerge(raw.autoMergeRequest);
  return {
    provider: "github", number, title: asString(raw.title) ?? `#${number}`, url, baseRef,
    ...(asString(raw.headRefName) ? { headRef: asString(raw.headRefName) } : {}),
    ...statusFields(asString(raw.state), raw.isDraft, summarizeGitHubChecks(raw.statusCheckRollup), raw.body),
    ...(autoMerge ? { autoMerge } : {}),
  };
}

/** `glab mr view -F json` for the checkout's branch. */
export function parseGitLabBranchRequest(output: string): ReviewRequest | undefined {
  const raw = record(JSON.parse(output));
  const number = asNumber(raw.iid);
  const baseRef = asString(raw.target_branch);
  const url = asString(raw.web_url);
  if (number === undefined || !baseRef || !url) return undefined;
  const autoMerge = gitlabAutoMerge(raw);
  return {
    provider: "gitlab", number, title: asString(raw.title) ?? `!${number}`, url, baseRef,
    ...(asString(raw.source_branch) ? { headRef: asString(raw.source_branch) } : {}),
    ...statusFields(asString(raw.state), typeof raw.draft === "boolean" ? raw.draft : raw.work_in_progress, summarizeGitLabPipeline(raw.head_pipeline ?? raw.pipeline), raw.description),
    ...(autoMerge ? { autoMerge } : {}),
  };
}
