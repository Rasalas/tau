import type { UiFileDiff } from "tau/host-extension";
import type {
  MergeMethod,
  MergeOutcome,
  PendingReviewComment,
  ProviderInfo,
  PullRequestCheck,
  PullRequestDetail,
  PullRequestFile,
  PullRequestLabel,
  PullRequestListEntry,
  PullRequestListState,
  PullRequestRef,
  PullRequestReviewEvent,
  PullRequestStack,
  PullRequestStackMembership,
  PullRequestThread,
  PullRequestViewedState,
  RequestService,
  ReviewRequest,
  SourceProviderStatus,
  StackAction,
} from "./protocol.js";
import type { CliCall } from "./pull-request-cli.js";
import type { PipelineFacts } from "./pipeline.js";

/*
 * The source-control provider interface: everything Review Kit asks a host
 * about requests, whichever host it is. A provider reaches its host through
 * its own CLI or through the credential Git's helper holds; Tau stores no
 * credential. An optional member is a capability the provider may lack;
 * `ProviderInfo.capabilities` says the same to the desktop, which hides it.
 */

/** A repository on a host, as the provider addresses it. */
export interface RepositoryTarget {
  host: string;
  /** The path below the host: `owner/name`, a GitLab group path, or `organization/project/repository` on Azure DevOps. */
  repo: string;
  /** A checkout of it, for a CLI that reads its remote. */
  cwd?: string;
}

/** A checkout's branch, for the request it has. */
export interface BranchTarget extends RepositoryTarget {
  cwd: string;
  branch: string;
  fresh: boolean;
}

export interface CreateRequestInput {
  title: string;
  body: string;
  base: string;
  head: string;
  draft: boolean;
}

export interface ListRequestsInput {
  state: PullRequestListState;
  limit: number;
  search?: string;
}

/** One file of a request's diff, before its viewed mark is known. */
export interface ChangedFileEntry {
  file: Omit<PullRequestFile, "viewed">;
  diff: UiFileDiff;
}

export interface LineCommentInput {
  path: string;
  line: number;
  side: "new" | "old";
  body: string;
}

export interface SourceControlProvider {
  readonly kind: RequestService;
  readonly info: ProviderInfo;
  /** What the machine lacks to use this provider, in words; undefined when nothing is missing. */
  missing(): string | undefined;
  /** The host and repository a remote URL names, spelled as this provider addresses them. */
  repository(remoteUrl: string): RepositoryTarget | undefined;
  /** The web URL of request `number`. */
  requestUrl(target: RepositoryTarget, number: number): string;
  /** Whether the CLI or credential is signed in for the host; asked before a write. */
  signedIn(target: RepositoryTarget & { cwd: string }): Promise<boolean>;
  /** The signed-in login on a host, or undefined when it will not say. */
  viewer(host: string): Promise<string | undefined>;
  /** Whether the machine is set up for it, without a repository: for Settings → Review. */
  status(): Promise<Omit<SourceProviderStatus, "service" | "name" | "tool" | "installed">>;

  /** The request of a checkout's branch, open or not. */
  current(branch: BranchTarget): Promise<ReviewRequest | undefined>;
  /** Opens a request; the URL the host answered with, when it said one. */
  create(target: RepositoryTarget & { cwd: string }, input: CreateRequestInput): Promise<string | undefined>;
  /**
   * Merges now. Without `cwd` the target names the repository alone, as a
   * request opened by its URL does. `deleteBranch` asks for the request's
   * branch to go too, where `capabilities.deleteBranch` says the host can.
   */
  merge(target: RepositoryTarget, request: ReviewRequest, method: MergeMethod, options?: MergeOptions): Promise<MergeOutcome | void>;
  /** Arms a merge that runs once the host allows it, or takes it back (`capabilities.autoMerge`). */
  autoMerge?(target: RepositoryTarget, request: ReviewRequest, enable: boolean, method: MergeMethod | undefined, options?: MergeOptions): Promise<void>;
  /** Opens a request that reverts a merged one (`capabilities.revert`); the URL of the new one. */
  revert?(ref: PullRequestRef, known: PullRequestDetail): Promise<string | undefined>;
  edit(target: RepositoryTarget & { cwd: string }, request: ReviewRequest, input: { title?: string; body?: string }): Promise<void>;
  setDraft(target: RepositoryTarget & { cwd: string }, request: ReviewRequest, draft: boolean): Promise<void>;

  /** One state's requests, `limit` at most; `more` when the host had further rows. */
  list(target: RepositoryTarget & { cwd: string }, input: ListRequestsInput, viewer: string | undefined): Promise<{ entries: PullRequestListEntry[]; more: boolean }>;

  detail(ref: PullRequestRef, fresh: boolean): Promise<PullRequestDetail>;
  /** Never cached: checks move on their own. */
  checks(ref: PullRequestRef): Promise<PullRequestCheck[]>;
  /** The workflow files and usual job durations of the checks' runs, by run id. */
  pipeline?(ref: PullRequestRef, runIds: readonly string[]): Promise<PipelineFacts>;
  threads(ref: PullRequestRef, fresh: boolean): Promise<PullRequestThread[]>;
  changes?(ref: PullRequestRef, fresh: boolean): Promise<ChangedFileEntry[]>;
  /** Viewed marks kept on the host; without it the kit keeps them itself. */
  viewedMarks?: {
    states(ref: PullRequestRef, fresh: boolean): Promise<Map<string, PullRequestViewedState>>;
    /** `detail` is the view's cached read, for an id the marks need. */
    set(ref: PullRequestRef, path: string, viewed: boolean, detail: () => Promise<PullRequestDetail>): Promise<void>;
  };
  comment(ref: PullRequestRef, body: string): Promise<void>;
  reply?(ref: PullRequestRef, threadId: string, body: string): Promise<void>;
  lineComment?(ref: PullRequestRef, input: LineCommentInput, known: PullRequestDetail): Promise<void>;
  update(ref: PullRequestRef, input: { title?: string; body?: string }): Promise<void>;
  review(ref: PullRequestRef, input: { event: PullRequestReviewEvent; body: string; comments: readonly PendingReviewComment[] }, known: PullRequestDetail): Promise<void>;
  resolve?(ref: PullRequestRef, threadId: string, resolved: boolean): Promise<void>;
  editComment?(ref: PullRequestRef, input: { id: string; kind: "comment" | "review" | "review-comment"; body: string }): Promise<void>;
  reviewers?(ref: PullRequestRef, add: readonly string[], remove: readonly string[]): Promise<void>;
  labels?(ref: PullRequestRef, add: readonly string[], remove: readonly string[]): Promise<void>;
  /** The labels and reviewers a picker offers; either may come back empty. */
  candidates?(ref: PullRequestRef): Promise<{ labels: PullRequestLabel[]; reviewers: string[] }>;

  /** The stack a request is a layer of; undefined for one on its own (`capabilities.stacks`). */
  stack?(ref: PullRequestRef, fresh: boolean): Promise<PullRequestStack | undefined>;
  /** The stack positions of listed requests, by number; a request on its own is left out. */
  stackMemberships?(target: RepositoryTarget, numbers: readonly number[]): Promise<Map<number, PullRequestStackMembership>>;
  /**
   * Merges `ref` with the unmerged layers below it, or rebases every layer
   * onto the one below. `seen` is the stack as the user confirmed it: a layer
   * that moved since refuses the step.
   */
  stackAction?(ref: PullRequestRef, input: { action: StackAction; seen: PullRequestStack; method?: MergeMethod }): Promise<void>;
}

export interface MergeOptions {
  deleteBranch?: boolean;
}

/** An HTTP answer a provider reads: the status, the headers it cares about and the text. */
export interface HttpAnswer {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type HttpFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal; redirect?: "follow" }) => Promise<HttpAnswer>;

/** A username and secret Git's credential helper holds for a host. */
export interface GitCredential {
  username: string;
  password: string;
}

export interface CliOptions {
  cwd?: string;
  maxBuffer?: number;
  host?: string;
  /** Reads a call that exited 0 and throws when it failed all the same. */
  inspect?(stdout: string, stderr: string): void;
}

/** What every provider is built on: the host's CLIs, HTTP, the read cache and the kit's other seams. */
export interface ProviderTools {
  findCommand(name: string): string | undefined;
  log(event: string, detail: string): void;
  /**
   * Runs one call of `kind`'s CLI; a missing CLI or a failure becomes a
   * sentence naming what is missing. `host` keys the rate-limit pause.
   */
  cli(kind: RequestService, call: CliCall, action: string, options?: CliOptions): Promise<string>;
  /** Asks a host over HTTP, rate limits honoured; anything but 2xx rejects with the status in its message. */
  http(kind: RequestService, url: string, init: { method?: string; headers?: Record<string, string>; body?: string; action: string; host: string }): Promise<HttpAnswer>;
  /** The credential Git's own helper holds for `https://<host>`, without prompting; undefined when it has none. */
  credential(host: string): Promise<GitCredential | undefined>;
  /** A read of one request, reused for a minute unless `fresh`; a failed read is not kept. */
  cached<T>(kind: string, ref: PullRequestRef, fresh: boolean, read: () => Promise<T>): Promise<T>;
  /** Drops one kind of a request's cached reads. */
  drop(kind: string, ref: PullRequestRef): void;
  /** Drops every cached read of a request, after a write. */
  forget(ref: PullRequestRef): void;
  /** Workspace Kit's commands that name Review Kit as a caller. */
  workspace(command: string, input?: unknown): Promise<unknown>;
  now(): number;
  /** Waits between two polls of a step the host finishes later. */
  wait(ms: number): Promise<void>;
}

/** GitLab and Forgejo answer a page at a time; this reads pages until a short one. */
export async function readPages(read: (page: number) => Promise<string>, pageSize = 100, maxPages = 30): Promise<string> {
  const rows: unknown[] = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const answer = JSON.parse(await read(page)) as unknown;
    const batch = Array.isArray(answer) ? answer : [];
    rows.push(...batch);
    if (batch.length < pageSize) break;
  }
  return JSON.stringify(rows);
}
