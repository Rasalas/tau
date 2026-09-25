/**
 * Remote Work Kit's vocabulary (plan-H §2, ADR 0027): a project's state goes
 * to another machine as a Git bundle, a worktree there picks it up, and what
 * was done there comes back as a branch here. Both machines run this kit; the
 * sending side ("here", A) drives, the receiving side ("there", B) never
 * reaches back.
 */

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
  /** A checkpoint tree (`refs/tau/checkpoints/…/after`) to send instead of the working copy. */
  snapshotRef?: string;
  /** Ignored files that go along, relative to the checkout; the project's remembered choice without it. */
  ignored?: string[];
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
  | { state: "branch"; branch: string; tip: string; commits: number; files: number; fetchedAt: number };

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
