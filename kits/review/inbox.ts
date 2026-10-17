import type { LocalReview } from "./local-reviews.js";
import { requestNumber, type PullRequestListEntry, type PullRequestLists } from "./protocol.js";

/**
 * The Reviews inbox: the threads' local branches and the open pull requests
 * that wait for the user, as one list ordered by the next step. No React here.
 */
export type InboxSectionId = "ready" | "review" | "thread";
export const INBOX_SECTIONS: ReadonlyArray<{ id: InboxSectionId; title: string }> = [
  { id: "ready", title: "Ready to merge" },
  { id: "review", title: "Your review" },
  { id: "thread", title: "Needs the thread" },
];

/** An open request with what the inbox needs beside it: whose it is, and the project its repository belongs to. */
export interface InboxPull {
  entry: PullRequestListEntry;
  /** The signed-in account wrote it. */
  mine: boolean;
  /** The projects here that list the repository; empty for another machine's. */
  workspaces: readonly string[];
}

export type InboxTone = "ok" | "bad" | "warn" | "muted";
export type InboxStatusKind = "passed" | "none" | "running" | "failed" | "stopped" | "conflicts" | "note" | "rebase" | "changes" | "draft" | "merged" | "request-merged" | "already";
export interface InboxStatus { kind: InboxStatusKind; text: string; tone: InboxTone }

/** The row's one button, or `wait` for the quiet "Waiting". */
export type InboxAction = "merge" | "review" | "rebase" | "fix" | "open" | "wait";

export interface InboxItem {
  key: string;
  section: InboxSectionId;
  /** The thread's branch; a request on that branch rides along as `pull`. */
  review?: LocalReview;
  pull?: InboxPull;
  status: InboxStatus;
  action: InboxAction;
  /** The project key the sidebar filters by. */
  project?: string;
  at: number;
}

/** A script run's state, as Project Scripts reports it. */
export interface RunState { status: "running" | "succeeded" | "failed" | "stopped" }

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`;

/** Every open request in the lists, each marked with whether the viewer of its host wrote it. */
export function openPulls(answer: PullRequestLists | undefined): InboxPull[] {
  return (answer?.lists ?? []).flatMap((list) => list.entries.filter((entry) => entry.state === "open").map((entry) => {
    const viewer = (entry.viewer ?? list.viewer)?.toLowerCase();
    return { entry, mine: Boolean(viewer && entry.author?.login.toLowerCase() === viewer), workspaces: list.workspaces };
  }));
}

/** The request a thread's branch is on: the one it records, else an open one whose head is the branch in the project's repository. */
export function pairedPull(review: LocalReview, pulls: readonly InboxPull[]): InboxPull | undefined {
  if (review.request) {
    const recorded = pulls.find((pull) => pull.entry.ref.url === review.request!.url);
    if (recorded) return recorded;
  }
  return pulls.find((pull) => pull.workspaces.includes(review.project.key) && pull.entry.headRef === review.branch);
}

/** The note "Ask to fix" sends the thread: what the request needs before it can merge. */
export function fixRequest(entry: PullRequestListEntry): string {
  const number = requestNumber(entry.ref.service, entry.ref.number);
  if (entry.checks === "failing") {
    const names = entry.checkRuns?.filter((run) => run.status === "failed" || run.status === "cancelled").map((run) => run.name).slice(0, 5) ?? [];
    return `The checks of pull request ${number} fail${names.length ? `: ${names.join(", ")}` : ""}. Find out why, fix it on this branch, run the checks again and push.`;
  }
  return `Pull request ${number} has changes requested. Read the review comments, address them on this branch and push.`;
}

const failedChecks = (entry: PullRequestListEntry) => entry.checkRuns?.filter((run) => run.status === "failed" || run.status === "cancelled").length ?? 0;

/** What a request's checks say, in the status cell's words. */
export function pullChecks(entry: PullRequestListEntry): InboxStatus {
  if (entry.checks === "passing") return { kind: "passed", text: "Checks passed", tone: "ok" };
  if (entry.checks === "pending") return { kind: "running", text: "Checks running", tone: "muted" };
  if (entry.checks === "failing") {
    const failed = failedChecks(entry);
    return { kind: "failed", text: failed ? `${plural(failed, "check")} failed` : "Checks failed", tone: "bad" };
  }
  return { kind: "none", text: "No checks", tone: "muted" };
}

/** What a worktree's script runs say, in the same words. */
export function runChecks(runs: readonly RunState[]): InboxStatus {
  if (runs.length === 0) return { kind: "none", text: "No checks", tone: "muted" };
  const failed = runs.filter((run) => run.status === "failed").length;
  if (failed) return { kind: "failed", text: `${plural(failed, "check")} failed`, tone: "bad" };
  if (runs.some((run) => run.status === "running")) return { kind: "running", text: "Checks running", tone: "muted" };
  const stopped = runs.filter((run) => run.status === "stopped").length;
  if (stopped) return { kind: "stopped", text: `${plural(stopped, "check")} stopped`, tone: "warn" };
  return { kind: "passed", text: "Checks passed", tone: "ok" };
}

/** What blocks a request on the host, if anything: conflicts, failing checks, a change request. */
function pullTrouble(entry: PullRequestListEntry): InboxStatus | undefined {
  if (entry.mergeable === "conflicting") return { kind: "conflicts", text: "Conflicts", tone: "warn" };
  if (entry.checks === "failing") return pullChecks(entry);
  if (entry.reviewDecision === "changes-requested") return { kind: "changes", text: "Changes requested", tone: "warn" };
  return undefined;
}

/** One request's status cell on All pull requests: what blocks it first, then a draft, then its checks. */
export function pullStatus(entry: PullRequestListEntry): InboxStatus {
  if (entry.state === "merged") return { kind: "merged", text: "Merged", tone: "muted" };
  if (entry.state === "closed") return { kind: "none", text: "Closed", tone: "muted" };
  return pullTrouble(entry) ?? (entry.draft ? { kind: "draft", text: "Draft", tone: "muted" } : pullChecks(entry));
}

function localItem(review: LocalReview, pull: InboxPull | undefined, runs: readonly RunState[]): InboxItem {
  const base = { key: review.key, review, ...(pull ? { pull } : {}), project: review.project.key, at: review.at };
  if (review.ask) return { ...base, section: "thread", action: "wait", status: review.ask.kind === "note" ? { kind: "note", text: "Note sent", tone: "muted" } : { kind: "rebase", text: "Rebase asked", tone: "muted" } };
  if (review.state === "conflicts") return { ...base, section: "thread", action: "rebase", status: { kind: "conflicts", text: "Conflicts", tone: "warn" } };
  const trouble = pull ? pullTrouble(pull.entry) : undefined;
  if (trouble) return { ...base, section: "thread", action: trouble.kind === "conflicts" ? "rebase" : "fix", status: trouble };
  if (pull?.entry.draft) return { ...base, section: "ready", action: "merge", status: { kind: "draft", text: "Draft", tone: "muted" } };
  if (pull?.entry.checks === "pending") return { ...base, section: "ready", action: "wait", status: pullChecks(pull.entry) };
  return { ...base, section: "ready", action: "merge", status: pull?.entry.checks ? pullChecks(pull.entry) : runChecks(runs) };
}

function pullItem(pull: InboxPull, project: string | undefined): InboxItem | undefined {
  const { entry } = pull;
  if (entry.draft) return undefined;
  const base = { key: entry.ref.url, pull, ...(project ? { project } : {}), at: Date.parse(entry.updatedAt) || 0 };
  if (!pull.mine) return entry.reviewRequested ? { ...base, section: "review", action: "review", status: pullChecks(entry) } : undefined;
  const trouble = pullTrouble(entry);
  if (trouble) return { ...base, section: "thread", action: "open", status: trouble };
  if (entry.checks === "pending") return { ...base, section: "ready", action: "wait", status: pullChecks(entry) };
  return { ...base, section: "ready", action: "merge", status: pullChecks(entry) };
}

/** A section's rows: the ones with a step to take first, then the newest. */
const byStep = (left: InboxItem, right: InboxItem) => Number(left.action === "wait") - Number(right.action === "wait") || right.at - left.at;

/**
 * The inbox from the window's reviews and the open requests: a branch with a
 * request shows once, drafts and other people's requests nobody asked the
 * user to review stay out, and empty sections are left out.
 */
export function buildInbox(
  reviews: readonly LocalReview[],
  pulls: readonly InboxPull[],
  runsOf: (review: LocalReview) => readonly RunState[] = () => [],
  projectOf: (workspace: string | undefined) => string | undefined = (workspace) => workspace,
): Array<{ id: InboxSectionId; title: string; items: InboxItem[] }> {
  const items: InboxItem[] = [];
  const taken = new Set<string>();
  for (const review of reviews) {
    if (review.state === "merged") continue;
    const pull = pairedPull(review, pulls);
    if (pull) taken.add(pull.entry.ref.url);
    items.push(localItem(review, pull, runsOf(review)));
  }
  for (const pull of pulls) {
    if (taken.has(pull.entry.ref.url)) continue;
    const item = pullItem(pull, projectOf(pull.workspaces[0]));
    if (item) items.push(item);
  }
  return INBOX_SECTIONS
    .map((section) => ({ ...section, items: items.filter((item) => item.section === section.id).sort(byStep) }))
    .filter((section) => section.items.length > 0);
}

/** How a merged review reads in the Merged list. */
export function mergedStatus(review: LocalReview): InboxStatus {
  if (review.mergedBy === "request") return { kind: "request-merged", text: "Pull request merged", tone: "muted" };
  if (review.mergedBy) return { kind: "already", text: `Already in ${review.target}`, tone: "muted" };
  return { kind: "merged", text: "Merged", tone: "muted" };
}
