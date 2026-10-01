import type { PullRequestChecksState, PullRequestLabel, PullRequestListEntry, PullRequestRef, PullRequestReviewDecision } from "./protocol.js";
import { githubCheckStatus, parseGitHubChecks, parseRequestUrl } from "./pull-request-json.js";

type Json = Record<string, unknown>;

const record = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const list = (value: unknown): Json[] => Array.isArray(value) ? value.map(record) : [];
const text = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value : undefined;
const count = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? value : 0;

function labels(value: unknown): PullRequestLabel[] {
  return (Array.isArray(value) ? value : []).flatMap((label): PullRequestLabel[] => {
    if (typeof label === "string") return label.trim() ? [{ name: label }] : [];
    const name = text(record(label).name);
    const color = text(record(label).color)?.replace(/^#/u, "");
    return name ? [{ name, ...(color && /^[0-9a-f]{6}$/iu.test(color) ? { color: color.toLowerCase() } : {}) }] : [];
  });
}

function actor(value: unknown): PullRequestListEntry["author"] {
  const raw = record(value);
  // `gh` names an app author `app/<slug>`; the row shows the slug.
  const login = text(raw.login)?.replace(/^app\//u, "") ?? text(raw.username);
  if (!login) return undefined;
  const name = text(raw.name);
  const bot = raw.is_bot === true || raw.bot === true || /\[bot\]$/u.test(login);
  return { login, ...(name && name !== login ? { name } : {}), ...(bot ? { bot } : {}) };
}

const DECISIONS: Record<string, PullRequestReviewDecision> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes-requested",
  REVIEW_REQUIRED: "review-required",
};

/** The rollup's rows folded into one state, the worst news winning; skipped and neutral runs pass. */
export function rollupState(rollup: unknown): PullRequestChecksState | undefined {
  const rows = list(rollup);
  if (rows.length === 0) return undefined;
  const statuses = rows.map(githubCheckStatus);
  if (statuses.some((status) => status === "failed" || status === "cancelled")) return "failing";
  if (statuses.some((status) => status === "pending" || status === "action-required")) return "pending";
  return "passing";
}

function githubState(raw: Json): PullRequestListEntry["state"] {
  const state = text(raw.state)?.toUpperCase();
  if (state === "MERGED") return "merged";
  if (state === "CLOSED") return "closed";
  return "open";
}

/** `gh pr list --json …` (see `GITHUB_LIST_FIELDS`); rows without a readable URL are dropped. */
export function parseGitHubList(output: string, viewer: string | undefined): PullRequestListEntry[] {
  const me = viewer?.toLowerCase();
  return list(JSON.parse(output)).flatMap((raw): PullRequestListEntry[] => {
    const ref = parseRequestUrl(text(raw.url) ?? "");
    if (!ref) return [];
    const author = actor(raw.author);
    const mergeable = text(raw.mergeable)?.toUpperCase();
    const decision = DECISIONS[text(raw.reviewDecision)?.toUpperCase() ?? ""];
    const checks = rollupState(raw.statusCheckRollup);
    const checkRuns = parseGitHubChecks(raw.statusCheckRollup);
    const requested = list(raw.reviewRequests).some((request) => text(request.login)?.toLowerCase() === me);
    return [{
      ref,
      title: text(raw.title) ?? `#${ref.number}`,
      ...(author ? { author } : {}),
      headRef: text(raw.headRefName) ?? "",
      baseRef: text(raw.baseRefName) ?? "",
      state: githubState(raw),
      draft: raw.isDraft === true,
      ...(mergeable === "MERGEABLE" ? { mergeable: "mergeable" as const } : mergeable === "CONFLICTING" ? { mergeable: "conflicting" as const } : {}),
      additions: count(raw.additions),
      deletions: count(raw.deletions),
      createdAt: text(raw.createdAt) ?? "",
      updatedAt: text(raw.updatedAt) ?? text(raw.createdAt) ?? "",
      labels: labels(raw.labels),
      ...(decision ? { reviewDecision: decision } : {}),
      ...(checks ? { checks } : {}),
      ...(checkRuns.length ? { checkRuns } : {}),
      reviewRequested: Boolean(me) && requested,
    }];
  });
}

function gitlabState(state: string | undefined): PullRequestListEntry["state"] {
  const value = state?.toLowerCase();
  if (value === "merged") return "merged";
  if (value === "closed" || value === "locked") return "closed";
  return "open";
}

/**
 * `glab api projects/:id/merge_requests`: GitLab lists no line counts and no
 * pipeline, so those stay blank; "not approved" is the closest it has to
 * GitHub's review summary.
 */
export function parseGitLabList(output: string, viewer: string | undefined): PullRequestListEntry[] {
  const me = viewer?.toLowerCase();
  return list(JSON.parse(output)).flatMap((raw): PullRequestListEntry[] => {
    const ref: PullRequestRef | undefined = parseRequestUrl(text(raw.web_url) ?? "");
    if (!ref) return [];
    const author = actor(raw.author);
    const detailed = text(raw.detailed_merge_status)?.toLowerCase();
    const conflicting = raw.has_conflicts === true || detailed === "conflict";
    const requested = list(raw.reviewers).some((reviewer) => text(reviewer.username)?.toLowerCase() === me);
    return [{
      ref,
      title: text(raw.title) ?? `!${ref.number}`,
      ...(author ? { author } : {}),
      headRef: text(raw.source_branch) ?? "",
      baseRef: text(raw.target_branch) ?? "",
      state: gitlabState(text(raw.state)),
      draft: raw.draft === true || raw.work_in_progress === true,
      ...(conflicting ? { mergeable: "conflicting" as const } : detailed === "mergeable" ? { mergeable: "mergeable" as const } : {}),
      additions: 0,
      deletions: 0,
      createdAt: text(raw.created_at) ?? "",
      updatedAt: text(raw.updated_at) ?? text(raw.created_at) ?? "",
      labels: labels(raw.labels),
      ...(detailed === "not_approved" ? { reviewDecision: "review-required" as const } : {}),
      ...(detailed === "ci_still_running" ? { checks: "pending" as const } : {}),
      reviewRequested: Boolean(me) && requested,
    }];
  });
}
