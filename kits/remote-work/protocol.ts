import type { TransferredPromptAttachment, UiPromptAttachment } from "tau/host-extension";

/**
 * Remote Work Kit's vocabulary (plan-H §2, ADR 0027): a project's state goes
 * to another machine as a Git bundle, a worktree there picks it up, and what
 * was done there comes back as a branch here. Both machines run this kit; the
 * sending side ("here", A) drives, the receiving side ("there", B) never
 * reaches back.
 */

import type { UiThreadUsage } from "tau";

export const REMOTE_WORK_EXTENSION_ID = "tau.remote-work";

/** Bumped when a command's input or answer changes shape; both sides say theirs. */
export const REMOTE_WORK_PROTOCOL = 1;

/** Pushed to this machine's clients with the whole `RepoTransfer` whenever it changes. */
export const TRANSFER_EVENT = "transfer";

/** A receiving side emits an operation's snapshot under this topic; the sending side watches it. */
export const OPERATION_EVENT = "operation";
export const operationTopic = (id: string) => `operation/${id}`;

/** The ref that holds the state a transfer sent, on this machine. */
export const transferRef = (id: string) => `refs/tau/transfer/${id}`;

// ---------------------------------------------------------------------------
// Steps, as the sending side shows them

export type TransferStepState = "pending" | "running" | "done" | "failed" | "skipped";

export type TransferStepId = "state" | "check" | "mirror" | "bundle" | "upload" | "unpack" | "worktree" | "files" | "setup";

export interface TransferStep {
  id: TransferStepId;
  label: string;
  state: TransferStepState;
  /** One line about what happened or why it was skipped. */
  detail?: string;
  /** 0–1 while an upload runs. */
  fraction?: number;
}

// ---------------------------------------------------------------------------
// Sending side (A): commands this kit's clients and other kits call here

/** A project's identity across machines: its normalized origin URL, else its root commit. */
export interface RepoIdentity {
  /** A folder-safe name for the mirror on the other machine: `github.com-acme-app-3f2a9c01d4`. */
  key: string;
  /** The checkout's folder name, for the worktree's folder there. */
  name: string;
  /** `origin` without credentials, when the repository has one. */
  origin?: string;
  /** Where `key` came from. */
  source: "origin" | "root-commit";
}

export interface SendRepoInput {
  /** A machine this host holds a key for: its host id, or its name when unique. */
  machine: string;
  /** A folder inside the checkout whose state goes. */
  cwd: string;
  /** Names the branch the result comes back on (`tau/<machine>/<slug of name>`). */
  name?: string;
  /** Ignored files that go along, relative to the checkout; the project's remembered choice without it. */
  ignored?: string[];
  /** An admitted checkout on the target to reuse as the worktree's repository. */
  targetWorkspace?: string;
}

export type RepoTransferState = "sending" | "ready" | "failed" | "discarded";

/** What a finished transfer made on the other machine. */
export interface RemoteWorktree {
  /** Absolute, on the other machine. */
  path: string;
  branch: string;
  /** The workspace id the other host admitted the worktree under, for starting a thread there. */
  workspaceId?: string;
}

/** The result as it came back: a branch here, or nothing because nothing changed there. */
export type TransferResult =
  | { state: "nothing"; fetchedAt: number }
  | { state: "branch"; branch: string; tip: string; commits: number; files: number; fetchedAt: number; paths?: string[] };

/** At most this many of a result's changed files are named in `TransferResult.paths`. */
export const RESULT_PATHS_MAX = 200;

export interface TransferApplied {
  state: BranchApplyState;
  at: number;
  commit?: string;
  files: string[];
  detail: string;
}

/** One transfer from here, as this machine's book keeps it (`<stateDir>/transfers.json`). */
export interface RepoTransfer {
  id: string;
  /** The other machine's host id, and its name when the transfer started. */
  machine: string;
  machineName: string;
  /** The checkout's top folder here. */
  root: string;
  repo: RepoIdentity;
  /** The commit that carries the state that went: HEAD, or a state commit on top of it. */
  base: string;
  /** HEAD here when it went. */
  head: string;
  name?: string;
  ignored: string[];
  createdAt: number;
  state: RepoTransferState;
  steps: TransferStep[];
  error?: string;
  remote?: RemoteWorktree;
  result?: TransferResult;
  applied?: TransferApplied;
}

/** `merged` changed the checkout; every other state left it as it was. */
export type BranchApplyState = "merged" | "already-merged" | "conflict" | "blocked";

/** What applying the result would do, checked with `git merge-tree` and nothing else. */
export interface TransferPreview {
  transfer: string;
  branch: string;
  clean: boolean;
  merged: boolean;
  conflicts: string[];
}

/** An ignored path Tau offers to send along, and why. */
export interface IgnoredCandidate {
  /** Relative to the checkout, POSIX separators; a folder ends in `/`. */
  path: string;
  kind: "file" | "folder";
  /** `env`: a `.env*` file. `issues`: a folder of notes or issues. `text`: small text. */
  reason: "env" | "issues" | "text";
  files: number;
  bytes: number;
}

/** An ignored path Tau does not offer: dependencies, builds, caches, or too large. */
export interface IgnoredSkipped {
  path: string;
  why: "build" | "large" | "binary" | "system";
}

export interface IgnoredFilesView {
  root: string;
  key: string;
  candidates: IgnoredCandidate[];
  /** What the user ticked for this project, still present. */
  selected: string[];
  skipped: IgnoredSkipped[];
}

/**
 * The typed surface of the sending side. The commands of the same names take
 * these inputs; H06's thread service and other kits (`callers`) use it.
 */
export interface RemoteRepoCommands {
  send: { input: SendRepoInput; output: RepoTransfer };
  transfers: { input: { cwd?: string } | undefined; output: RepoTransfer[] };
  transfer: { input: { transfer: string }; output: RepoTransfer };
  "fetch-result": { input: { transfer: string }; output: RepoTransfer };
  preview: { input: { transfer: string }; output: TransferPreview };
  apply: { input: { transfer: string }; output: RepoTransfer };
  discard: { input: { transfer: string }; output: RepoTransfer };
  "ignored-files": { input: { cwd: string }; output: IgnoredFilesView };
  "set-ignored-files": { input: { cwd: string; paths: string[] }; output: IgnoredFilesView };
}

/** Kits that may drive transfers on this machine (ADR 0020): threads on another machine, and the handoff to one. */
export const TRANSFER_CALLERS = ["tau.agents", "tau.handoff"] as const;

/**
 * `{ workspaces: string[] }` (ids or paths of projects this host admitted) →
 * `{ [workspace]: key | null }`: each one's repository identity (`identity.ts`),
 * null where it has none. Read only, so another machine's window may ask.
 */
export const PROJECT_IDENTITIES_COMMAND = "project-identities";
export const MAX_PROJECT_IDENTITIES = 50;
/** Review Kit's Reviews page lists threads whose work came back, and merges or asks them (`threads`, `preview`, `thread-send`, `thread-settle`). */
export const REVIEW_CALLERS = [...TRANSFER_CALLERS, "tau.review"] as const;

// ---------------------------------------------------------------------------
// Receiving side (B): commands the sending side's host calls there

export type OperationState = "running" | "done" | "failed";

/** A long piece of work on the receiving side, started by one call and followed by topic and poll. */
export interface OperationSnapshot<Result = unknown> {
  id: string;
  kind: "prepare" | "receive" | "result";
  state: OperationState;
  steps: TransferStep[];
  result?: Result;
  error?: string;
}

export interface PrepareInput {
  protocol: number;
  transfer: string;
  repo: RepoIdentity;
}

export interface PrepareResult {
  protocol: number;
  /** Commits the mirror there has at the tips of its refs; the bundle leaves out what they reach. */
  tips: string[];
  mirror: "cloned" | "fetched" | "empty" | "kept";
  /** Confirms support for reusing an explicitly named target checkout. */
  reusedCheckout?: boolean;
}

/** An ignored file on its way, inside the `receive` call itself. */
export interface IgnoredFilePayload {
  path: string;
  /** Permission bits, `0o644` or `0o755`. */
  mode: number;
  /** Base64. */
  data: string;
}

export interface ReceiveInput {
  protocol: number;
  transfer: string;
  repo: RepoIdentity;
  base: string;
  /** The bundle the sending side uploaded; absent when the mirror has `base` already. */
  blob?: { id: string; sha256: string };
  files?: IgnoredFilePayload[];
  /** What the work is called (a thread's title, an agent's name); the worktree's folder and branch there carry its slug. */
  name?: string;
  /** The sending machine's name; the branch there is `tau/<from>/<slug>`. */
  from?: string;
}

export interface SetupRun {
  name: string;
  status: string;
  exitCode?: number;
}

export interface ReceiveResult {
  worktree: string;
  branch: string;
  base: string;
  workspaceId?: string;
  setup: SetupRun[];
}

export interface ResultInput {
  protocol: number;
  transfer: string;
}

export type ResultAnswer =
  | { state: "nothing"; tip: string }
  | { state: "bundle"; tip: string; commits: number; files: number; size: number; sha256: string };

/** A piece of the result bundle, read by the sending side; the receiving side never sends on its own. */
export interface DownloadInput {
  transfer: string;
  offset: number;
  length: number;
}

/** At most this much per `download` call: 4 MB of bytes is about 5.3 MB of base64. */
export const DOWNLOAD_PIECE_BYTES = 4 * 1024 * 1024;

export interface RemoveInput {
  transfer: string;
}

export const RECEIVING_COMMANDS = {
  prepare: "mirror-prepare",
  receive: "worktree-receive",
  result: "worktree-result",
  download: "result-download",
  remove: "worktree-remove",
  operation: "operation",
} as const;

// Project Scripts runs a new worktree's setup; this kit is one of its callers.
export const PROJECT_SCRIPTS_EXTENSION_ID = "tau.project-scripts";
export const WORKTREE_CREATED_COMMAND = "worktree-created";

// ---------------------------------------------------------------------------
// Threads on another machine (H06): the service `tau.remote-work/threads`

/**
 * Names the thread service other kits reach here, as host commands with
 * `callers` (ADR 0020); `remoteThreadsClient` in `threads-client.ts` types it.
 */
export const REMOTE_THREADS_SERVICE = "tau.remote-work/threads";

/** Pushed to this machine's clients with the whole `RemoteThreadLink` whenever it changes. */
export const THREAD_LINK_EVENT = "thread-link";

/** The receiving side emits a hosted thread's report under this topic; the sending side watches it. */
export const HOSTED_THREAD_EVENT = "hosted-thread";
export const hostedThreadTopic = (thread: string) => `hosted-thread/${thread}`;

/** What a thread there is doing, as that machine derives it (`isStreaming`, `ui_prompt_*`, the last turn). */
export type HostedThreadState = "starting" | "running" | "waiting" | "idle" | "failed" | "gone";

/** How the last turn that ended went; `interrupted` when that machine stopped during it. */
export type HostedTurnOutcome = "completed" | "failed" | "aborted" | "interrupted";

/** A thread one machine runs for another, as it reports it. Its clock, not the caller's. */
export interface HostedThreadReport {
  /** The thread's id there. */
  thread: string;
  state: HostedThreadState;
  /** Turns that ended since it started there. */
  turns: number;
  outcome?: HostedTurnOutcome;
  /** The provider's error of a failed last answer, or why the thread could not go on. */
  error?: string;
  /** What it asks while `waiting` on a dialog. */
  question?: string;
  /** The last answer, shortened. */
  lastMessage?: string;
  usage?: UiThreadUsage;
  model?: { provider: string; id: string };
  title?: string;
  updatedAt: number;
  /** Orders reports of one run of that host: a lower revision of the same epoch is older. */
  epoch: string;
  revision: number;
}

/**
 * A link's status here: its thread's state there, or what stands between.
 * `sending` while the project's state travels, `offline` while the machine
 * is unreachable (the thread may still run there), `settled` once its work
 * was applied or let go.
 */
export type RemoteThreadStatus = "sending" | HostedThreadState | "offline" | "settled";

/** Statuses a `wait` waits through. */
export const BUSY_REMOTE_STATUSES: readonly RemoteThreadStatus[] = ["sending", "starting", "running"];

export interface RemoteThreadModel {
  provider: string;
  id: string;
}

/** What `thread-start` takes. Either `prompt` or `session`, or both (the prompt then continues the session). */
export interface RemoteThreadStartInput {
  attachments?: readonly UiPromptAttachment[];
  thinkingLevel?: string;
  mode?: string;
  /** A machine this host holds a key for: its host id, or its name when unique. */
  machine: string;
  /** A folder of the checkout here whose state the thread starts from. */
  cwd: string;
  prompt?: string;
  /** A Pi thread here whose session goes along (`sessions.import` there); its history stays native. */
  session?: { threadId: string };
  title?: string;
  /** The runtime backend there; Pi when absent. */
  backend?: string;
  model?: RemoteThreadModel;
  /** The thread here that started it; kept in the link only, the machine there never sees it. */
  parentThreadId?: string;
  /** An agent definition's name, kept in the link for the kit that spawned it. */
  agent?: string;
  /** Ignored files that go along; the project's remembered choice without it. */
  ignored?: string[];
  /**
   * How deep in a tree of sub-agents the thread starts (1 for a user's thread's
   * child). The machine there keeps it, so its Agents Kit lets the thread nest
   * only the levels that are left.
   */
  agentDepth?: number;
}

/** How a settled link ended. */
export interface RemoteThreadSettled {
  how: "applied" | "discarded";
  at: number;
  detail: string;
}

/** One thread started from here on another machine (`<stateDir>/remote-links.json`). */
export interface RemoteThreadLink {
  /** The handle other kits keep; it exists before the thread there does. */
  id: string;
  machine: string;
  machineName: string;
  cwd: string;
  /** The checkout's top folder here. */
  root: string;
  title?: string;
  parentThreadId?: string;
  agent?: string;
  backend?: string;
  model?: RemoteThreadModel;
  /** The transfer that carried the state; its worktree there is where the thread works. */
  transfer?: string;
  /** The commit the thread started from. */
  base?: string;
  /** The worktree there, and its branch. */
  worktree?: string;
  worktreeBranch?: string;
  /** The thread's id there, once it exists. */
  thread?: string;
  status: RemoteThreadStatus;
  /** The last report from there; it stays while the machine is offline. */
  there?: HostedThreadReport;
  /** Tokens and money the thread used there, as it last reported. */
  usage?: UiThreadUsage;
  /** Why it failed: a start that never got there, or the last answer's error. */
  error?: string;
  result?: TransferResult;
  applied?: TransferApplied;
  settled?: RemoteThreadSettled;
  createdAt: number;
  updatedAt: number;
  /** When this side last heard about it from there. */
  seenAt?: number;
}

/** Why a `thread-wait` came back. */
export type RemoteThreadWaitReason = "idle" | "waiting" | "failed" | "gone" | "settled" | "offline" | "timeout";

export interface RemoteThreadWaitResult {
  reason: RemoteThreadWaitReason;
  link: RemoteThreadLink;
}

export type RemoteThreadDelivery = "prompt" | "steer" | "queue";

/**
 * The typed surface of `tau.remote-work/threads`. The commands of the same
 * names take these inputs, from this machine's clients and from `callers`.
 */
export interface RemoteThreadCommands {
  "thread-start": { input: RemoteThreadStartInput; output: RemoteThreadLink };
  threads: { input: { machine?: string; parentThreadId?: string; active?: boolean } | undefined; output: RemoteThreadLink[] };
  thread: { input: { link: string }; output: RemoteThreadLink };
  "thread-send": { input: { link: string; text: string; delivery?: RemoteThreadDelivery }; output: RemoteThreadLink };
  "thread-abort": { input: { link: string }; output: RemoteThreadLink };
  /** Waits until the thread is no longer busy, the machine goes offline, or `timeoutMs` (30 s by default, at most 30 min). */
  "thread-wait": { input: { link: string; timeoutMs?: number }; output: RemoteThreadWaitResult };
  /** Brings the worktree's state back as `tau/<machine>/<slug>`; refused while the thread runs. */
  "thread-result": { input: { link: string }; output: RemoteThreadLink };
  /**
   * `apply` merges the result when clean and then lets the worktree there go; `discard` lets it go at once.
   * `removeThread` also moves the thread there into that machine's trash, so its rail keeps only its own work.
   */
  "thread-settle": { input: { link: string; how: "apply" | "discard"; removeThread?: boolean }; output: RemoteThreadLink };
}

export const DEFAULT_REMOTE_WAIT_MS = 30_000;
export const MAX_REMOTE_WAIT_MS = 30 * 60_000;

// Receiving side (B): what the sending side's host calls there for threads.

export interface HostedHello {
  protocol: number;
  attachments?: boolean;
}

export interface HostedThreadStartInput {
  attachments?: readonly TransferredPromptAttachment[];
  thinkingLevel?: string;
  mode?: string;
  protocol: number;
  /** The transfer whose worktree the thread works in; only the device that sent it may start one. */
  transfer: string;
  prompt?: string;
  /** A Pi session file from the sending side, with the thread it continues there. */
  session?: { jsonl: string; origin: { hostId: string; threadId: string } };
  title?: string;
  backend?: string;
  model?: RemoteThreadModel;
  agentDepth?: number;
}

export const HOSTED_COMMANDS = {
  hello: "hosted-hello",
  start: "hosted-thread-start",
  send: "hosted-thread-send",
  abort: "hosted-thread-abort",
  reports: "hosted-threads",
  remove: "hosted-thread-remove",
} as const;

/**
 * Asked on the machine that runs the thread, by its own Agents Kit: how deep
 * in a tree of sub-agents a thread started for another machine is. Answers
 * `{ depth }`, absent for a thread no other machine started.
 */
export const HOSTED_DEPTH_COMMAND = "hosted-thread-depth";

/** The deepest a sub-agent tree goes; a start that claims more is refused. */
export const MAX_AGENT_DEPTH_CLAIM = 8;
