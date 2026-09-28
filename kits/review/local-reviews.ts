import type { UiProject, UiSession } from "tau";

/**
 * Reviews: a thread that worked on a branch of its own in a worktree and is
 * done appears as a local merge request, across projects. Both halves share
 * this module; no React and no host code here.
 */
export const REVIEWS_PAGE = "review.reviews";
/** Pushed when an ask, a note or a merge changed the book; the page reads again. */
export const LOCAL_REVIEWS_EVENT = "local-reviews-changed";

/** Workspace Kit's `thread-branches` answer, mirrored rather than imported (Review imports no Workspace file). */
export interface ThreadBranch {
  path: string;
  root: string;
  branch: string;
  target?: string;
  tip: string;
  ahead: number;
  behind: number;
  files: number;
  added: number;
  removed: number;
  paths: Array<{ path: string; added: number; removed: number }>;
  uncommitted: number;
  committedAt?: number;
  merged: boolean;
  conflicts: string[];
  unavailable?: string;
  /** The worktree's workspace id, as a thread working there names its project. */
  workspace: string;
  rootWorkspace: string;
}

/** What Workspace Kit's `merge-thread-branch` answers. */
export interface ThreadBranchMerge {
  branch: string;
  state: "merged" | "already-merged" | "conflict" | "blocked";
  commit?: string;
  files: string[];
  detail: string;
  into: string;
  root: string;
}

/** A request sent back to the thread: rebase onto the target, or the user's note. Open until the branch moves. */
export interface ReviewAsk {
  kind: "rebase" | "note";
  text: string;
  at: number;
  /** The tip it was about; a new commit answers it. */
  tip: string;
  threadId?: string;
}

/** A merge made from the page, kept after the worktree is gone. */
export interface MergedReview {
  key: string;
  root: string;
  branch: string;
  target: string;
  workspace?: string;
  rootWorkspace?: string;
  threadId?: string;
  title: string;
  project?: string;
  commit?: string;
  at: number;
  files: number;
  added: number;
  removed: number;
  costUsd?: number;
  modelProvider?: string;
  model?: string;
}

/**
 * A thread on another machine whose work came back as a branch here (Remote
 * Work's link, "Bring back"), not merged yet. Merge goes through Remote Work's
 * `thread-settle`, which merges the same way and lets the worktree there go.
 */
export interface RemoteReview {
  link: string;
  machine: string;
  root: string;
  rootWorkspace?: string;
  /** The branch the checkout has out, where the merge lands. */
  target?: string;
  title?: string;
  /** The thread here it continues or was spawned from. */
  threadId?: string;
  branch: string;
  tip: string;
  commits: number;
  files: number;
  paths: string[];
  conflicts: string[];
  merged: boolean;
  modelProvider?: string;
  model?: string;
  backend?: string;
  costUsd?: number;
  at: number;
}

export interface LocalReviewsAnswer {
  branches: ThreadBranch[];
  asks: Record<string, ReviewAsk>;
  merged: MergedReview[];
  /** Absent from a host without Remote Work. */
  remote?: RemoteReview[];
}

export const remoteReviewKey = (link: string): string => `remote:${link}`;

export type ReviewState = "ready" | "requested" | "conflicts" | "merged";
export const REVIEW_STATES: readonly ReviewState[] = ["ready", "requested", "conflicts", "merged"];

/** Project Scripts' last run of each script in the worktree. */
export interface ReviewChecks {
  passed: number;
  failed: number;
  running: number;
  names: string[];
}

export interface LocalReview {
  key: string;
  state: ReviewState;
  title: string;
  branch: string;
  target: string;
  root: string;
  /** The worktree; absent for a merge whose worktree is gone. */
  path?: string;
  workspace?: string;
  project: { key: string; name: string; icon?: string };
  /** The thread that did the work: the latest of those in the worktree. */
  threadId?: string;
  threads: number;
  tip?: string;
  files: number;
  added: number;
  removed: number;
  paths: ThreadBranch["paths"];
  uncommitted: number;
  behind: number;
  conflicts: string[];
  unavailable?: string;
  ask?: ReviewAsk;
  costUsd?: number;
  modelProvider?: string;
  model?: string;
  backendKind?: string;
  /** Last activity: the thread's or the tip's, whichever is later; the merge for a merged one. */
  at: number;
  checks?: ReviewChecks;
  merged?: MergedReview;
  /** Work that ran on another machine and came back as a branch here. */
  remote?: { link: string; machine: string };
}

export const reviewKey = (root: string, branch: string): string => `${root}\n${branch}`;

export interface ReviewInputs {
  answer: LocalReviewsAnswer;
  threads: readonly UiSession[];
  projects?: readonly UiProject[];
  /** Threads with a turn in flight or a question open: not done yet. */
  busy: ReadonlySet<string>;
  checks?: (path: string) => ReviewChecks | undefined;
}

const baseName = (path: string) => path.replace(/[\\/]+$/u, "").split(/[\\/]/u).at(-1) ?? path;

function projectOf(rootWorkspace: string | undefined, root: string, thread: UiSession | undefined, projects: readonly UiProject[] | undefined): LocalReview["project"] {
  const found = projects?.find((project) => (rootWorkspace && project.workspaceId === rootWorkspace) || project.path === root);
  return {
    key: rootWorkspace ?? root,
    name: found?.name ?? thread?.projectName ?? baseName(root),
    ...(found?.icon ? { icon: found.icon } : {}),
  };
}

const costOf = (threads: readonly UiSession[]) => {
  const priced = threads.filter((thread) => thread.usage);
  return priced.length ? priced.reduce((sum, thread) => sum + (thread.usage?.costUsd ?? 0), 0) : undefined;
};

/**
 * The page's rows from the host's answer and the window's threads. A branch
 * counts once a thread works in its worktree and none of them is busy; it is
 * merged when the target holds it, changes requested while an ask about its
 * tip is open, in conflict when `merge-tree` says so, and ready otherwise. A
 * branch with neither commits nor uncommitted work is nothing to review.
 */
export function deriveReviews({ answer, threads, projects, busy, checks }: ReviewInputs): LocalReview[] {
  const reviews: LocalReview[] = [];
  const seen = new Set<string>();
  const records = new Map(answer.merged.map((record) => [record.key, record]));
  for (const branch of answer.branches) {
    const own = threads.filter((thread) => thread.workspaceId === branch.workspace).sort((left, right) => right.modifiedAt - left.modifiedAt);
    if (own.length === 0 || own.some((thread) => busy.has(thread.id))) continue;
    const key = reviewKey(branch.root, branch.branch);
    const record = records.get(key);
    const latest = own[0]!;
    const ask = answer.asks[key]?.tip === branch.tip ? answer.asks[key] : undefined;
    if (!branch.merged && branch.ahead === 0 && branch.uncommitted === 0) continue;
    const state: ReviewState = branch.merged ? "merged" : ask ? "requested" : branch.conflicts.length > 0 ? "conflicts" : "ready";
    seen.add(key);
    const cost = costOf(own);
    const scriptChecks = checks?.(branch.path);
    reviews.push({
      key,
      state,
      title: latest.title || branch.branch,
      branch: branch.branch,
      target: branch.target ?? record?.target ?? "",
      root: branch.root,
      path: branch.path,
      workspace: branch.workspace,
      project: projectOf(branch.rootWorkspace, branch.root, latest, projects),
      threadId: latest.id,
      threads: own.length,
      tip: branch.tip,
      // A merged branch reads nothing against its target any more; the merge kept what it carried.
      files: record && branch.merged ? record.files : branch.files,
      added: record && branch.merged ? record.added : branch.added,
      removed: record && branch.merged ? record.removed : branch.removed,
      paths: branch.paths,
      uncommitted: branch.uncommitted,
      behind: branch.behind,
      conflicts: branch.conflicts,
      ...(branch.unavailable ? { unavailable: branch.unavailable } : {}),
      ...(ask ? { ask } : {}),
      ...(cost !== undefined ? { costUsd: cost } : record?.costUsd !== undefined ? { costUsd: record.costUsd } : {}),
      ...(latest.modelProvider ? { modelProvider: latest.modelProvider } : {}),
      ...(latest.model ? { model: latest.model } : {}),
      ...(latest.backendKind ? { backendKind: latest.backendKind } : {}),
      at: record && branch.merged ? record.at : Math.max(latest.modifiedAt, branch.committedAt ?? 0),
      ...(scriptChecks ? { checks: scriptChecks } : {}),
      ...(record ? { merged: record } : {}),
    });
  }
  for (const remote of answer.remote ?? []) {
    const key = remoteReviewKey(remote.link);
    if (seen.has(key) || records.has(key)) continue;
    seen.add(key);
    const thread = remote.threadId ? threads.find((candidate) => candidate.id === remote.threadId) : undefined;
    const ask = answer.asks[key]?.tip === remote.tip ? answer.asks[key] : undefined;
    reviews.push({
      key,
      state: remote.merged ? "merged" : ask ? "requested" : remote.conflicts.length > 0 ? "conflicts" : "ready",
      title: remote.title || thread?.title || remote.branch,
      branch: remote.branch,
      target: remote.target ?? "",
      root: remote.root,
      project: projectOf(remote.rootWorkspace, remote.root, thread, projects),
      threads: 1,
      tip: remote.tip,
      files: remote.files,
      added: 0,
      removed: 0,
      paths: remote.paths.map((path) => ({ path, added: 0, removed: 0 })),
      uncommitted: 0,
      behind: 0,
      conflicts: remote.conflicts,
      ...(remote.target ? {} : { unavailable: "The checkout is not on a branch." }),
      ...(ask ? { ask } : {}),
      ...(remote.costUsd !== undefined ? { costUsd: remote.costUsd } : {}),
      ...(remote.modelProvider ? { modelProvider: remote.modelProvider } : {}),
      ...(remote.model ? { model: remote.model } : {}),
      ...(remote.backend ? { backendKind: remote.backend } : {}),
      at: remote.at,
      remote: { link: remote.link, machine: remote.machine },
    });
  }
  // Merges whose worktree is gone, or whose thread is: the record is all there is.
  for (const record of answer.merged) {
    if (seen.has(record.key)) continue;
    const thread = record.threadId ? threads.find((candidate) => candidate.id === record.threadId) : undefined;
    const cost = thread?.usage ? thread.usage.costUsd : record.costUsd;
    reviews.push({
      key: record.key,
      state: "merged",
      title: thread?.title || record.title,
      branch: record.branch,
      target: record.target,
      root: record.root,
      ...(record.workspace ? { workspace: record.workspace } : {}),
      project: projectOf(record.rootWorkspace, record.root, thread, projects),
      ...(thread ? { threadId: thread.id } : {}),
      threads: thread ? 1 : 0,
      files: record.files,
      added: record.added,
      removed: record.removed,
      paths: [],
      uncommitted: 0,
      behind: 0,
      conflicts: [],
      ...(cost !== undefined ? { costUsd: cost } : {}),
      ...(record.modelProvider ? { modelProvider: record.modelProvider } : {}),
      ...(record.model ? { model: record.model } : {}),
      ...(thread?.backendKind ? { backendKind: thread.backendKind } : {}),
      at: record.at,
      merged: record,
    });
  }
  return reviews.sort((left, right) => right.at - left.at);
}

export interface ReviewCounts {
  ready: number;
  requested: number;
  conflicts: number;
  merged: number;
  /** Open reviews per project key: ready, requested and conflicts. */
  projects: Array<{ key: string; name: string; icon?: string; open: number }>;
}

export function countReviews(reviews: readonly LocalReview[]): ReviewCounts {
  const counts: ReviewCounts = { ready: 0, requested: 0, conflicts: 0, merged: 0, projects: [] };
  const projects = new Map<string, ReviewCounts["projects"][number]>();
  for (const review of reviews) {
    counts[review.state] += 1;
    const entry = projects.get(review.project.key) ?? { ...review.project, open: 0 };
    if (review.state !== "merged") entry.open += 1;
    projects.set(review.project.key, entry);
  }
  counts.projects = [...projects.values()].sort((left, right) => right.open - left.open || left.name.localeCompare(right.name));
  return counts;
}

/** What waits for the user: ready to merge, or in conflict. Changes requested wait for the thread. */
export const needsYou = (counts: Pick<ReviewCounts, "ready" | "conflicts">): number => counts.ready + counts.conflicts;

/** Merges made from the page since the first of this month, and what their threads cost. */
export function mergedThisMonth(reviews: readonly LocalReview[], now = Date.now()): { count: number; costUsd: number } {
  const date = new Date(now);
  const start = new Date(date.getFullYear(), date.getMonth(), 1).getTime();
  const month = reviews.filter((review) => review.merged && review.merged.at >= start);
  return { count: month.length, costUsd: month.reduce((sum, review) => sum + (review.costUsd ?? 0), 0) };
}

/** What the thread is asked to do when the user asks it to rebase. */
export function rebaseRequest(review: Pick<LocalReview, "branch" | "target" | "conflicts">): string {
  const files = review.conflicts.slice(0, 8).map((path) => `\`${path}\``).join(", ");
  return [
    `Please rebase \`${review.branch}\` onto \`${review.target}\`${files ? ` and resolve the conflicts in ${files}${review.conflicts.length > 8 ? " and more" : ""}` : ""}.`,
    "Keep your work, run the checks again and commit the result on this branch. Do not merge it yourself; it is merged from Reviews.",
  ].join(" ");
}

/** The user's note, sent back to the thread. */
export function noteRequest(review: Pick<LocalReview, "branch">, note: string): string {
  return `A review of \`${review.branch}\` asks for changes:\n\n${note.trim()}\n\nAddress it on this branch and commit; it is merged from Reviews afterwards.`;
}

/** Why Merge is off for a row, or undefined when it may merge. */
export function mergeBlocker(review: LocalReview): string | undefined {
  if (review.state === "merged") return "Already merged.";
  if (review.unavailable) return review.unavailable;
  if (review.uncommitted > 0) return `${review.uncommitted} file${review.uncommitted === 1 ? " is" : "s are"} not committed; ask the thread to commit first.`;
  if (review.conflicts.length > 0) return `Conflicts with ${review.target} in ${review.conflicts.length} file${review.conflicts.length === 1 ? "" : "s"}; ask the thread to rebase.`;
  return undefined;
}
