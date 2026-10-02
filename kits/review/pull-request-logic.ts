import type { UiDiffLine, UiFileDiff } from "tau";
import {
  providerInfo,
  REQUEST_SERVICES,
  type PullRequestCheck,
  type PullRequestComment,
  type PullRequestDetail,
  type PullRequestFile,
  type PullRequestRef,
  type PullRequestThread,
  type RequestService,
  type ReviewCommentChip,
  type ReviewRequest,
} from "./protocol.js";

/** What a stage tab of the view holds: enough to name it before anything loaded. */
export interface PullRequestTabParams extends Record<string, unknown> {
  url: string;
  number: number;
  service: RequestService;
  /** The checkout it was opened from, so the rail row follows what the view reads. */
  workspace?: string;
  /** Opened at its checks; `at` tells one such ask from the next. */
  focus?: "checks";
  at?: number;
}

export function pullRequestTabParams(params: Record<string, unknown>): PullRequestTabParams | undefined {
  const { url, number, service, workspace, focus, at } = params;
  if (typeof url !== "string" || typeof number !== "number" || !REQUEST_SERVICES.includes(service as RequestService)) return undefined;
  return { url, number, service: service as RequestService, ...(typeof workspace === "string" ? { workspace } : {}), ...(focus === "checks" ? { focus, ...(typeof at === "number" ? { at } : {}) } : {}) };
}

export const shortNoun = (service: PullRequestRef["service"]): "PR" | "MR" => providerInfo(service).short;
export const hostName = (service: PullRequestRef["service"]): string => providerInfo(service).name;

export type ChecksRollup = "failing" | "pending" | "passing";

export function checksRollup(checks: readonly PullRequestCheck[]): ChecksRollup | undefined {
  if (checks.some((check) => check.status === "failed" || check.status === "cancelled")) return "failing";
  if (checks.some((check) => check.status === "pending" || check.status === "action-required")) return "pending";
  if (checks.some((check) => check.status === "passed")) return "passing";
  return undefined;
}

export const ROLLUP_TITLES: Record<ChecksRollup, string> = {
  failing: "Some checks were not successful",
  pending: "Some checks haven't completed yet",
  passing: "All checks have passed",
};

/** The one line beside the Summary tab: the worst news first. */
export function checksSummary(checks: readonly PullRequestCheck[]): string {
  const total = checks.length;
  if (total === 0) return "No checks reported";
  const failing = checks.filter((check) => check.status === "failed" || check.status === "cancelled").length;
  if (failing > 0) return `${failing} of ${total} failing`;
  const waiting = checks.filter((check) => check.status === "action-required").length;
  if (waiting > 0) return `${waiting} ${waiting === 1 ? "check" : "checks"} awaiting action`;
  const running = checks.filter((check) => check.status === "pending").length;
  if (running > 0) return `${running} of ${total} running`;
  const passing = checks.filter((check) => check.status === "passed").length;
  return passing === total ? "All checks passed" : `${passing} of ${total} passing`;
}

/** The rail row's request, as the view last read it. */
export function asReviewRequest(detail: PullRequestDetail, checks: readonly PullRequestCheck[]): ReviewRequest {
  // As the rail's own detector counts: skipped and neutral runs pass.
  const failed = checks.filter((check) => check.status === "failed" || check.status === "cancelled").length;
  const pending = checks.filter((check) => check.status === "pending" || check.status === "action-required").length;
  return {
    provider: detail.ref.service,
    number: detail.ref.number,
    title: detail.title,
    url: detail.ref.url,
    baseRef: detail.baseRef,
    ...(detail.headRef ? { headRef: detail.headRef } : {}),
    state: detail.state,
    draft: detail.draft,
    body: detail.body,
    ...(checks.length > 0 ? { checks: { passed: checks.length - failed - pending, failed, pending, total: checks.length } } : {}),
  };
}

export type TimelineItem =
  | { kind: "opened"; key: string; at: string; author?: string }
  | { kind: "commit"; key: string; at: string; oid: string; headline: string; author?: string }
  | { kind: "verdict"; key: string; at: string; comment: PullRequestComment }
  | { kind: "conversation"; key: string; at: string; comments: PullRequestComment[] }
  | { kind: "closed" | "merged"; key: string; at: string };

/**
 * What happened to the request, one row per event: opened, each commit, each
 * run of plain comments folded into one conversation, each review with a
 * verdict, and the merge or close. Newest first unless `oldestFirst`.
 */
export function buildTimeline(detail: PullRequestDetail, oldestFirst = false): TimelineItem[] {
  const events: Array<Exclude<TimelineItem, { kind: "conversation" }> | { kind: "comment"; key: string; at: string; comment: PullRequestComment }> = [];
  if (detail.createdAt) events.push({ kind: "opened", key: "opened", at: detail.createdAt, ...(detail.author ? { author: detail.author.login } : {}) });
  for (const commit of detail.commits) events.push({ kind: "commit", key: `commit-${commit.oid}`, at: commit.committedAt, oid: commit.oid, headline: commit.headline, ...(commit.author ? { author: commit.author } : {}) });
  for (const comment of detail.comments) {
    const verdict = comment.kind === "review" && comment.verdict && comment.verdict !== "commented";
    events.push(verdict ? { kind: "verdict", key: `review-${comment.id}`, at: comment.createdAt, comment } : { kind: "comment", key: `comment-${comment.id}`, at: comment.createdAt, comment });
  }
  if (detail.state === "merged" && detail.mergedAt) events.push({ kind: "merged", key: "merged", at: detail.mergedAt });
  else if (detail.state === "closed" && detail.closedAt) events.push({ kind: "closed", key: "closed", at: detail.closedAt });
  events.sort((left, right) => left.at.localeCompare(right.at));
  const items: TimelineItem[] = [];
  for (const event of events) {
    if (event.kind !== "comment") { items.push(event); continue; }
    const last = items.at(-1);
    if (last?.kind === "conversation") {
      last.comments.push(event.comment);
      last.at = event.at;
    } else {
      items.push({ kind: "conversation", key: event.key, at: event.at, comments: [event.comment] });
    }
  }
  return oldestFirst ? items : items.reverse();
}

export function timelineCounts(detail: PullRequestDetail, threads: readonly PullRequestThread[]): { comments: number; commits: number; approvals: number } {
  return {
    comments: detail.comments.filter((comment) => comment.kind === "comment" || comment.body.trim()).length + threads.reduce((sum, thread) => sum + thread.comments.length, 0),
    commits: detail.commits.length,
    approvals: detail.reviewers.filter((reviewer) => reviewer.verdict === "approved").length,
  };
}

export const threadKey = (path: string, side: "new" | "old", line: number) => `${path}\0${side}\0${line}`;

/** Threads split into those a loaded diff shows a line for and those it does not. */
export function anchorThreads(threads: readonly PullRequestThread[], diffs: readonly UiFileDiff[]): { anchored: Map<string, PullRequestThread[]>; loose: PullRequestThread[] } {
  const lines = new Set<string>();
  for (const diff of diffs) {
    for (const line of diff.hunks.flatMap((hunk) => hunk.lines)) {
      if (line.newLine !== undefined) lines.add(threadKey(diff.path, "new", line.newLine));
      if (line.oldLine !== undefined) lines.add(threadKey(diff.path, "old", line.oldLine));
    }
  }
  const anchored = new Map<string, PullRequestThread[]>();
  const loose: PullRequestThread[] = [];
  for (const thread of threads) {
    const key = thread.line !== undefined && !thread.outdated ? threadKey(thread.path, thread.side, thread.line) : undefined;
    if (key && lines.has(key)) anchored.set(key, [...anchored.get(key) ?? [], thread]);
    else loose.push(thread);
  }
  return { anchored, loose };
}

/** Every key a diff line answers to: its new number, its old number, or both for a context line. */
export function lineKeys(path: string, line: UiDiffLine): string[] {
  return [
    ...(line.newLine !== undefined ? [threadKey(path, "new", line.newLine)] : []),
    ...(line.oldLine !== undefined ? [threadKey(path, "old", line.oldLine)] : []),
  ];
}

const GENERATED = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|go\.sum|poetry\.lock)$|\.snap$|\.min\.[a-z]+$|(^|\/)(dist|build|vendor|__generated__)\//u;
const TEST = /(^|\/)__tests__\/|\.(test|spec)\.[a-z0-9]+$/iu;

function subject(path: string): string {
  return path.replace(/(^|\/)__tests__\//u, "$1").replace(/\.(test|spec)(\.[a-z0-9]+)$/iu, "$2");
}

/**
 * Sources first, each test right after the source it tests, generated files
 * last; alphabetical within a tier. The whole-diff view reads top to bottom.
 */
export function orderFiles<T extends Pick<PullRequestFile, "path">>(files: readonly T[]): T[] {
  const byPath = [...files].sort((left, right) => left.path.localeCompare(right.path));
  const generated = byPath.filter((file) => GENERATED.test(file.path));
  const tests = byPath.filter((file) => !GENERATED.test(file.path) && TEST.test(file.path));
  const sources = byPath.filter((file) => !GENERATED.test(file.path) && !TEST.test(file.path));
  const ordered: T[] = [];
  const placed = new Set<T>();
  for (const source of sources) {
    ordered.push(source);
    for (const test of tests) {
      if (!placed.has(test) && subject(test.path) === source.path) { ordered.push(test); placed.add(test); }
    }
  }
  return [...ordered, ...tests.filter((test) => !placed.has(test)), ...generated];
}

/** "just now", "5m ago", "3h ago", "2d ago", else the date. */
export function relativeTime(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) return "";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 30 * 86_400) return `${Math.floor(seconds / 86_400)}d ago`;
  return new Date(at).toISOString().slice(0, 10);
}

/** A comment of the request as composer context: who said it, where, and the text. */
export function commentChip(detail: Pick<PullRequestDetail, "ref">, comment: PullRequestComment, thread?: Pick<PullRequestThread, "path" | "line">): ReviewCommentChip {
  const noun = `${shortNoun(detail.ref.service)} #${detail.ref.number}`;
  const place = thread ? `${thread.path}${thread.line !== undefined ? `:${thread.line}` : ""}` : undefined;
  return {
    kind: "text-excerpt",
    label: `${comment.author.login} on ${place ? place.split("/").at(-1) : noun}`,
    payload: { source: `${comment.author.login}'s comment on ${noun}${place ? ` at ${place}` : ""}`, text: comment.body.trim() || "(no text)" },
  };
}

/** A whole thread for the composer: each comment in order, one quote. */
export function threadChip(detail: Pick<PullRequestDetail, "ref">, thread: PullRequestThread): ReviewCommentChip {
  const place = `${thread.path}${thread.line !== undefined ? `:${thread.line}` : ""}`;
  const noun = `${shortNoun(detail.ref.service)} #${detail.ref.number}`;
  return {
    kind: "text-excerpt",
    label: `Thread on ${place.split("/").at(-1)}`,
    payload: {
      source: `Review thread on ${noun} at ${place}`,
      text: thread.comments.map((comment) => `${comment.author.login}: ${comment.body.trim()}`).join("\n\n"),
    },
  };
}
