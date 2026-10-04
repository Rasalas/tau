import type { ComponentType, ReactNode } from "react";
import type { UiEditor, UiFileDiff, UiReviewRequest, UiSession, UiWorkspaceChanges, WorkbenchActions } from "tau";

export const REVIEW_HOST_EXTENSION_ID = "tau.review";
export const WORKSPACE_HOST_EXTENSION_ID = "tau.workspace";
export const WORKSPACE_STORE_SERVICE = "tau.workspace/store";
export const WORKSPACE_CHANGES_PANEL = "changes";
export const REVIEW_DIFF_PANEL = "review.diff";
export const REVIEW_OVERLAY = "review.workspace";
/** The review sheet a compact client opens from its title bar. */
export const REVIEW_COMPACT_PANEL = "review";
/** Workspace Kit's push when a turn's changes were recorded, copied from its protocol. */
export const WORKSPACE_CHECKPOINT_EVENT = "checkpoint";

/** The slice of Workspace Kit's turn checkpoint the compact review reads (its `checkpoints` answer). */
export interface ReviewTurn extends UiWorkspaceChanges {
  id: string;
  sessionId: string;
  startedAt: number;
  endedAt: number;
  /** HEAD moved under the turn (Workspace Kit); files it could not attribute are left out. */
  headMove?: { uncertainFileCount: number };
}

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
    /** What other kits add to the Changes view. */
    changesSections?: readonly ComponentType<ChangesSectionProps>[];
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
  registerWorkspaceSummarySection?(section: ComponentType<import("tau").RegionProps>): () => void;
  /** Absent on a Workspace Kit that keeps its Changes panel whatever draws the review. */
  registerReviewView?(): () => void;
  stageFile?(path: string): Promise<void>;
  unstageFile?(path: string): Promise<void>;
  stageAll?(): Promise<void>;
  revertFile?(path: string): Promise<void>;
  registerThreadRowAccessory(accessory: ComponentType<{ session: UiSession }>): () => void;
  /** A section on a rail row's hover card (API 1.23.0); absent from an older Workspace Kit. */
  registerThreadCardSection?(section: { place: "section"; order?: number; Component: ComponentType<ThreadCardSectionProps> }): () => void;
}

/** What Workspace Kit hands a hover card's section (`ThreadCardSectionProps` in `kits/workspace/protocol.ts`). */
export interface ThreadCardSectionProps {
  session: UiSession;
  external: boolean;
  actions: WorkbenchActions;
  Row: ComponentType<{ icon: ReactNode; children: ReactNode; label?: string; onClick?(event: import("react").MouseEvent<HTMLButtonElement>): void }>;
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
  /** Newest first; `at` is the commit time in ms. */
  commits?: Array<{ subject: string; body: string; sha?: string; at?: number; author?: string }>;
  /** When the branch left its base, in ms. */
  forkedAt?: number;
  diffStat?: string;
  template?: string;
}

/** The source-control hosts Review Kit reaches, each through its own CLI or credential helper. */
export type RequestService = "github" | "gitlab" | "forgejo" | "bitbucket" | "azure-devops";
export const REQUEST_SERVICES: readonly RequestService[] = ["github", "gitlab", "forgejo", "bitbucket", "azure-devops"];
export type MergeMethod = "merge" | "squash" | "rebase";

/**
 * What a provider can do. The desktop hides what is missing rather than
 * offering a step that would fail; the host refuses it with the same words.
 */
export interface ProviderCapabilities {
  create: boolean;
  /** Title and description after creation. */
  edit: boolean;
  /** Create as a draft and switch between draft and ready. */
  draft: boolean;
  /** Merge methods offered from Tau; empty when merging is left to the website. */
  merge: readonly MergeMethod[];
  checks: boolean;
  /** The diff, so the view has a Code tab. */
  files: boolean;
  /** Conversations anchored on lines of the diff. */
  conversations: boolean;
  /** A new comment on a line, posted at once or held for a review. */
  lineComments: boolean;
  replies: boolean;
  resolve: boolean;
  /** The verdicts a review can carry; `comment` alone means reviews are plain comments. */
  reviewEvents: readonly PullRequestReviewEvent[];
  /** The kinds of comment the signed-in account can edit. */
  editComments: ReadonlyArray<"comment" | "review" | "review-comment">;
  reviewers: boolean;
  labels: boolean;
  /** Where viewed marks live: on the host, or in this Tau. */
  viewed: "host" | "local";
  /** Create a repository for a checkout without a remote. */
  publish: boolean;
  /** Arm a merge that waits for checks and approvals, and take it back. */
  autoMerge: boolean;
  /** Open a request that reverts a merged one. */
  revert: boolean;
  /** Delete the request's branch on the host once it merged. */
  deleteBranch: boolean;
  /** Requests stacked on one another, merged and rebased as one. */
  stacks: boolean;
}

/** How a provider is named in the UI, and what it can do. */
export interface ProviderInfo {
  kind: RequestService;
  name: string;
  /** "pull request" or "merge request". */
  noun: string;
  short: "PR" | "MR";
  /** The command that checks a request out, when the provider's CLI has one. */
  checkout?(number: number): string;
  /** The repository's web page. */
  repositoryUrl(host: string, repo: string): string;
  capabilities: ProviderCapabilities;
}

const EVERYTHING: ProviderCapabilities = {
  create: true, edit: true, draft: true, merge: ["squash", "merge", "rebase"], checks: true, files: true,
  conversations: true, lineComments: true, replies: true, resolve: true,
  reviewEvents: ["comment", "approve", "request-changes"], editComments: ["comment", "review", "review-comment"],
  reviewers: true, labels: true, viewed: "host", publish: true,
  autoMerge: true, revert: true, deleteBranch: true, stacks: true,
};

const plainUrl = (host: string, repo: string) => `https://${host}/${repo}`;

export const PROVIDERS: Readonly<Record<RequestService, ProviderInfo>> = {
  github: { kind: "github", name: "GitHub", noun: "pull request", short: "PR", checkout: (number) => `gh pr checkout ${number}`, repositoryUrl: plainUrl, capabilities: EVERYTHING },
  gitlab: {
    kind: "gitlab", name: "GitLab", noun: "merge request", short: "MR", checkout: (number) => `glab mr checkout ${number}`, repositoryUrl: plainUrl,
    // GitLab's API has no "request changes"; viewed marks are kept by the kit.
    capabilities: { ...EVERYTHING, reviewEvents: ["comment", "approve"], viewed: "local", revert: false, stacks: false },
  },
  forgejo: {
    kind: "forgejo", name: "Forgejo", noun: "pull request", short: "PR", checkout: (number) => `tea pr checkout ${number}`, repositoryUrl: plainUrl,
    capabilities: { ...EVERYTHING, replies: false, resolve: false, editComments: ["comment"], viewed: "local", publish: false, autoMerge: false, revert: false, stacks: false },
  },
  bitbucket: {
    kind: "bitbucket", name: "Bitbucket", noun: "pull request", short: "PR", repositoryUrl: plainUrl,
    capabilities: {
      ...EVERYTHING, merge: ["merge", "squash"], resolve: false, editComments: ["comment", "review-comment"], reviewers: false, labels: false, viewed: "local", publish: false,
      autoMerge: false, revert: false, stacks: false,
    },
  },
  "azure-devops": {
    kind: "azure-devops", name: "Azure DevOps", noun: "pull request", short: "PR", checkout: (number) => `az repos pr checkout --id ${number}`,
    repositoryUrl: (host, repo) => {
      const [organization, project, name] = repo.split("/");
      return `https://${host}/${organization}/${project}/_git/${name}`;
    },
    // `az` gives no diff and no labels; conversations and comments go through `az devops invoke`.
    capabilities: {
      ...EVERYTHING, merge: ["squash", "merge"], files: false, lineComments: false, reviewEvents: ["approve", "request-changes"],
      editComments: [], labels: false, viewed: "local", publish: false, revert: false, stacks: false,
    },
  },
};

export const providerInfo = (service: RequestService): ProviderInfo => PROVIDERS[service] ?? PROVIDERS.github;

/** Whether a provider can be used on this machine, for Settings → Review. */
export interface SourceProviderStatus {
  service: RequestService;
  name: string;
  /** The program or credential store the provider goes through. */
  tool: string;
  installed: boolean;
  /** Undefined when the tool cannot tell without a repository. */
  signedIn?: boolean;
  /** Who it is signed in as, or the servers it holds logins for. */
  account?: string;
  /** What to do next, in words. */
  hint?: string;
}

/** A self-hosted server's provider, chosen by the user, by host (with a port when it has one). */
export type SourceHosts = Record<string, RequestService>;

/** A merge armed to run once the host's checks and approvals allow it. */
export interface AutoMergeState {
  /** The method stored with it, where the host reports one. */
  method?: MergeMethod;
}

/** A branch's request as Review Kit reports it; core's type names only the first two hosts. */
export type ReviewRequest = Omit<UiReviewRequest, "provider"> & { provider: RequestService; autoMerge?: AutoMergeState };

/** What a merge did beside merging: the branch it deleted on the host, or why it kept it. */
export interface MergeOutcome {
  branchDeleted?: string;
  branchKept?: string;
}

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
  request?: ReviewRequest;
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

/** Which hosting CLIs could publish this checkout, and as whom. */
export interface PublishInfo {
  branch?: string;
  /** Set when the checkout already has a remote; there is nothing to publish then. */
  remote?: string;
  /** The checkout's folder name, the repository name a form suggests. */
  folder: string;
  services: Array<{ service: RequestService; ready: boolean; problem?: string; account?: string; protocol?: "https" | "ssh" }>;
}

export interface PublishResult {
  repository: string;
  url: string;
  remote: string;
  /** False for a repository without commits: the remote is set, nothing was pushed. */
  pushed: boolean;
  branch: string;
}

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
  startedAt?: string;
  completedAt?: string;
  /** Pending and not started yet. */
  queued?: boolean;
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
  /** Set while a merge is armed to run once the host allows it. */
  autoMerge?: AutoMergeState;
}

/** One layer of a stack, as the host lists it: bottom first. */
export interface PullRequestStackLayer {
  number: number;
  url: string;
  title?: string;
  headRef: string;
  headSha?: string;
  state: "open" | "closed" | "merged";
  draft?: boolean;
}

/** Requests stacked on one another, each based on the one below. */
export interface PullRequestStack {
  number: number;
  /** The branch the bottom layer merges into. */
  base: string;
  layers: PullRequestStackLayer[];
}

/** Where a listed request sits in its stack; `position` counts from 1 at the bottom. */
export interface PullRequestStackMembership {
  number: number;
  size: number;
  position: number;
}

/** Merge a layer with every unmerged one below it, or rebase every layer onto the one below. */
export type StackAction = "merge" | "rebase";

/** Steps on one request by its URL; the Changes panel's own steps act on the branch's request. */
export type PullRequestAction = "merge" | "auto-merge" | "cancel-auto-merge" | "revert";

export interface PullRequestActionResult {
  detail: PullRequestDetail;
  merge?: MergeOutcome;
  /** The request a revert opened. */
  created?: string;
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

/** A thread's tab of its project's requests. */
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
  /** The checks one by one, where the list read them (GitHub). */
  checkRuns?: PullRequestCheck[];
  /** The signed-in account is among the requested reviewers. */
  reviewRequested: boolean;
  /** Its layer in a stack, where the host keeps stacks. */
  stack?: PullRequestStackMembership;
  /** The signed-in login on the row's own host, where a page mixes hosts. */
  viewer?: string;
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

/** The page across projects: one list per repository, with the projects that share it. */
export interface PullRequestLists {
  lists: Array<PullRequestList & { workspaces: string[] }>;
  /** Projects whose repository could not be read, with the reason. */
  failures: Array<{ workspace: string; message: string }>;
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
  /** The submitted head commit, retained after a squash merge. */
  headSha?: string;
  baseRef?: string;
  /** The stack it is a layer of, where the host keeps stacks: its number and how many layers it has. */
  stack?: { number: number; size: number };
  refreshedAt?: number;
}

/** A thread's cached request for its branch, used to target and settle a local review. */
export interface BranchReviewRequest {
  target: string;
  tip?: string;
  merged: boolean;
  url: string;
  number: number;
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
  /** The line as the diff shows it, sent along with a note to a thread. */
  code?: string;
}
