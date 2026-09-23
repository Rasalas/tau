import type { ComponentType } from "react";
import type { UiEditor, UiFileDiff, UiReviewRequest, UiSession, UiWorkspaceChanges, WorkbenchActions } from "tau";

export const REVIEW_HOST_EXTENSION_ID = "tau.review";
export const WORKSPACE_HOST_EXTENSION_ID = "tau.workspace";
export const WORKSPACE_STORE_SERVICE = "tau.workspace/store";
export const WORKSPACE_CHANGES_PANEL = "changes";
export const REVIEW_OVERLAY = "review.workspace";
/** The kit that asks `pr-status` about a thread's checkout to settle it. */
export const THREAD_RAIL_EXTENSION_ID = "tau.thread-rail";

export interface WorkspaceStoreApi {
  getSnapshot(): {
    cwd?: string;
    workspaceId?: string;
    changes: UiWorkspaceChanges;
    committing: boolean;
    workspace?: { branch?: string; upstream?: string };
    review?: { path?: string; primaryPush: boolean };
  };
  subscribe(listener: () => void): () => void;
  activeEditor(): UiEditor | undefined;
  openReview(path?: string, pushPrimary?: boolean): void;
  selectReviewPath(path: string): void;
  closeReview(): void;
  commit(message: string, push: boolean): Promise<boolean>;
  openInEditor(relPath?: string, editorOverride?: string): Promise<void>;
  suggestCommitMessage(changes: UiWorkspaceChanges, diffs: readonly UiFileDiff[]): Promise<string | undefined>;
  registerCommitMessageSuggester(suggester: (request: {
    changes: UiWorkspaceChanges;
    diffs: readonly UiFileDiff[];
    actions: WorkbenchActions;
  }) => Promise<string>): () => void;
  refresh(): Promise<void>;
  registerChangesSection(section: ComponentType<ChangesSectionProps>): () => void;
  registerThreadRowAccessory(accessory: ComponentType<{ session: UiSession }>): () => void;
}

/** What Workspace Kit's Changes panel hands the section Review adds to it. */
export interface ChangesSectionProps {
  actions: WorkbenchActions;
  message: string;
  committed(): void;
}

/** The slice of Workspace Kit's `review-request-context` answer Review reads. */
export interface ReviewRequestContext {
  root: string;
  branch?: string;
  remote?: { name: string; url: string };
  upstream?: string;
  ahead?: number;
  base: string;
  commits?: Array<{ subject: string; body: string }>;
  diffStat?: string;
  template?: string;
}

export type RequestService = "github" | "gitlab";
export type MergeMethod = "merge" | "squash" | "rebase";

/**
 * Where the current branch stands on the way to a merged request: its Git
 * facts, the request when one exists, and the first thing missing for the
 * next step (no branch, no remote, no CLI, no login), in words for the user.
 */
export interface ReviewRequestStatus {
  branch?: string;
  /** The branch a new request merges into. */
  base: string;
  remote?: string;
  upstream?: string;
  ahead?: number;
  service: RequestService;
  request?: UiReviewRequest;
  problem?: string;
}

export interface ReviewRequestDraft {
  title: string;
  body: string;
  base: string;
  /** The model wrote it; false when the commits alone had to do. */
  generated: boolean;
}

export type CommitMessageStyle = "conventional" | "gitmoji" | "plain";

/**
 * Composer Context's chip service, copied from `kits/composer-context/protocol.ts`
 * (a kit never imports another): the slice Review uses to hand comments over.
 */
export const COMPOSER_CONTEXT_CHIPS_SERVICE = "tau.composer-context/chips";

export interface ReviewCommentChip {
  kind: "text-excerpt";
  label?: string;
  payload: { source: string; text: string };
}

/** The pull-request view hands its request over as the chip kind Composer Context has for one. */
export interface PullRequestChip {
  kind: "pull-request";
  payload: { number: number; title: string; url: string; branch?: string };
}

export interface ComposerContextChips {
  /** Throws when no composer is on screen. */
  addChip(chip: ReviewCommentChip | PullRequestChip): string;
  removeChip(id: string): void;
}

/**
 * A request the pull-request view addresses by its URL, whichever checkout it
 * came from: `repo` is `owner/name` on GitHub and the project's full path on GitLab.
 */
export interface PullRequestRef {
  service: RequestService;
  host: string;
  repo: string;
  number: number;
  url: string;
}

export interface PullRequestActor {
  login: string;
  name?: string;
  bot?: boolean;
}

export type PullRequestVerdict = "approved" | "changes-requested" | "commented" | "dismissed" | "pending";

export interface PullRequestReviewer {
  login: string;
  /** The latest verdict; "pending" while it was only requested. */
  verdict: PullRequestVerdict;
  team?: boolean;
}

export interface PullRequestLabel {
  name: string;
  /** Six hex digits as the host reports it; drawn as a dot, never as a colour of Tau's. */
  color?: string;
}

export type PullRequestCheckStatus = "passed" | "failed" | "cancelled" | "pending" | "action-required" | "skipped" | "neutral";

export interface PullRequestCheck {
  name: string;
  status: PullRequestCheckStatus;
  workflow?: string;
  description?: string;
  url?: string;
}

export interface PullRequestComment {
  id: string;
  kind: "comment" | "review" | "review-comment";
  author: PullRequestActor;
  body: string;
  createdAt: string;
  url?: string;
  /** A review's verdict; absent for plain comments. */
  verdict?: PullRequestVerdict;
}

export interface PullRequestCommit {
  oid: string;
  headline: string;
  author?: string;
  committedAt: string;
}

export interface PullRequestDetail {
  ref: PullRequestRef;
  /** The host's own id, which GitHub's GraphQL mutations take. */
  nodeId?: string;
  title: string;
  body: string;
  state: "open" | "closed" | "merged";
  draft: boolean;
  author?: PullRequestActor;
  createdAt?: string;
  updatedAt?: string;
  mergedAt?: string;
  closedAt?: string;
  baseRef: string;
  headRef?: string;
  headSha?: string;
  /** GitLab's position anchors for a new line comment. */
  diffRefs?: { base: string; head: string; start: string };
  additions: number;
  deletions: number;
  changedFiles: number;
  reviewers: PullRequestReviewer[];
  labels: PullRequestLabel[];
  checks: PullRequestCheck[];
  comments: PullRequestComment[];
  commits: PullRequestCommit[];
  /** The signed-in login on the host, so the view offers to edit only its own comments. */
  viewer?: string;
}

export interface PullRequestThread {
  id: string;
  path: string;
  line?: number;
  /** Which side of the diff `line` counts on: after the change, or before it. */
  side: "new" | "old";
  resolved: boolean;
  outdated: boolean;
  comments: PullRequestComment[];
}

/** "dismissed": marked viewed, then the file changed again. */
export type PullRequestViewedState = "viewed" | "unviewed" | "dismissed";

export interface PullRequestFile {
  path: string;
  previousPath?: string;
  status: "added" | "modified" | "deleted" | "renamed";
  added: number;
  removed: number;
  viewed: PullRequestViewedState;
}

export interface PullRequestFiles {
  files: PullRequestFile[];
  diffs: UiFileDiff[];
  /** Where the viewed marks live: on the host, or only in this Tau. */
  viewedOn: "host" | "local";
}

/** Ids of Review Kit's pull-request view: the stage-tab kind and its commands. */
export const PULL_REQUEST_TAB = "review.pull-request";

/** The Pull Requests page: every request of one project's repository. */
export const PULL_REQUESTS_TAB = "review.pull-requests";

export type PullRequestListState = "open" | "closed" | "merged" | "all";
/** GitHub's summary of the reviews; absent where the host keeps none. */
export type PullRequestReviewDecision = "approved" | "changes-requested" | "review-required";
export type PullRequestChecksState = "passing" | "failing" | "pending";

/** One row of the page, as the listing reads it: no conversation, no diff. */
export interface PullRequestListEntry {
  ref: PullRequestRef;
  title: string;
  author?: PullRequestActor;
  headRef: string;
  baseRef: string;
  state: "open" | "closed" | "merged";
  draft: boolean;
  mergeable?: "mergeable" | "conflicting";
  /** Zero where the host did not count them. */
  additions: number;
  deletions: number;
  createdAt: string;
  updatedAt: string;
  labels: PullRequestLabel[];
  reviewDecision?: PullRequestReviewDecision;
  checks?: PullRequestChecksState;
  /** The signed-in account is among the requested reviewers. */
  reviewRequested: boolean;
}

export interface PullRequestList {
  service: RequestService;
  host: string;
  repo: string;
  /** The signed-in login on that host; undefined when the CLI would not say. */
  viewer?: string;
  entries: PullRequestListEntry[];
  /** The host had more than `limit` rows for this question. */
  truncated: boolean;
  limit: number;
}

/**
 * A request a thread keeps beside it, whichever repository it lives in. The
 * snapshot fields are what the host said when it was last read.
 */
export interface ThreadPullRequestLink {
  url: string;
  service: RequestService;
  host: string;
  repo: string;
  number: number;
  /** Who linked it: the user, the agent's tool, or creating it from the Changes panel. */
  source: "user" | "agent" | "created";
  linkedAt: number;
  title?: string;
  state?: "open" | "closed" | "merged";
  draft?: boolean;
  headRef?: string;
  baseRef?: string;
  refreshedAt?: number;
}

/** Emitted with `{ threadId }` whenever a thread's links change. */
export const THREAD_LINKS_EVENT = "thread-links-changed";

export type PullRequestReviewEvent = "comment" | "approve" | "request-changes";

/** A line comment held for the review instead of posted at once. */
export interface PendingReviewComment {
  id: string;
  path: string;
  line: number;
  side: "new" | "old";
  body: string;
}
