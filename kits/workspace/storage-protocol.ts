/**
 * Workspace Kit's worktree storage contract: the cleanup rules, the storage
 * report and the `tau app` request. It imports nothing, so both halves read it
 * without pulling either one's code.
 */

/** The four rules T3 Code offers, under Tau's names. Every one is off by default. */
export interface WorktreeCleanupRules {
  /** Remove a worktree nobody worked in for this many days; `null` is off. */
  afterDays: number | null;
  /** Remove a worktree whose commits are all part of the default branch. */
  onMerge: boolean;
  /** Remove a worktree once the last thread that worked there was deleted. */
  onThreadDelete: boolean;
  /** Remove a worktree that has no commits beyond the base it started from. */
  unchanged: boolean;
}

/** A repository's own answer: the host's rules, none, or rules of its own on top of the host's. */
export type ProjectCleanupOverride = { mode: "off" } | { mode: "custom"; rules?: Partial<WorktreeCleanupRules> };

/** `<stateDir>/cleanup-policy.json`: the host's rules and the overrides, keyed by repository root. */
export interface CleanupPolicy {
  host: WorktreeCleanupRules;
  projects: Record<string, ProjectCleanupOverride>;
}

/** A change the storage page sends: host rules, or one repository's mode and rules. */
export type CleanupPolicyPatch =
  | { rules: Partial<WorktreeCleanupRules> }
  | { project: string; mode: "inherit" | "off" | "custom"; rules?: Partial<WorktreeCleanupRules> };

export type CleanupReason = "inactive" | "merged" | "thread-deleted" | "unchanged";

/** Why a worktree stays although a rule would take it. */
export type CleanupBlocker =
  | "not-recorded"
  | "missing"
  | "inspection-failed"
  | "outside-worktrees-dir"
  | "not-linked"
  | "host-workspace"
  | "thread-open"
  | "uncommitted"
  | "ignored-files"
  | "unpushed";

export interface CleanupVerdict {
  /** A rule matched and nothing blocks it: the next sweep removes it. */
  remove: boolean;
  reasons: CleanupReason[];
  blockers: CleanupBlocker[];
}

/** One worktree Tau made, as the storage page lists it. */
export interface UiStorageWorktree {
  path: string;
  /** The repository's main checkout. */
  repository: string;
  repositoryName: string;
  branch?: string;
  createdAt: number;
  lastActivityAt: number;
  /** Bytes on disk, `node_modules` included; absent when it could not be measured. */
  sizeBytes?: number;
  threadIds: string[];
  dirtyFiles: number;
  unpushedCommits: number;
  commitsBeyondBase: number;
  /** The rules that apply to its repository, and what they say about it. */
  rules: WorktreeCleanupRules;
  verdict: CleanupVerdict;
}

export interface UiStorageReport {
  worktrees: UiStorageWorktree[];
  totalBytes: number;
  policy: CleanupPolicy;
  /** The repository the host has open, whose override the page offers. */
  currentRepository?: { path: string; name: string };
  generatedAt: number;
  /** The last sweep that removed something, on this host. */
  lastSweep?: { at: number; removed: string[] };
}

export interface UiCleanupResult {
  removed: string[];
  /** Worktrees that were due but changed since the report and stayed. */
  kept: Array<{ path: string; blockers: CleanupBlocker[] }>;
}

/** Answer of a manual removal: done, or what the user has to confirm first. */
export type UiStorageRemoval =
  | { removed: true }
  | { removed: false; confirm: CleanupBlocker[]; dirtyFiles: number; unpushedCommits: number };

export interface WorktreeStorageHostCommands {
  /** Every worktree Tau recorded, measured and judged by the rules: the dry run. */
  "storage-report": { input: { sizes?: boolean } | undefined; output: UiStorageReport };
  "cleanup-policy": { input: CleanupPolicyPatch | undefined; output: CleanupPolicy };
  /** Removes what the rules say is due right now, re-checked one by one. */
  "cleanup-run": { input: { paths?: string[] } | undefined; output: UiCleanupResult };
  /** Removes one worktree by hand; `confirm` accepts what the first answer named. */
  "storage-remove": { input: { path: string; confirm?: boolean }; output: UiStorageRemoval };
}

/** Pushed after a sweep or a removal changed what is on disk. */
export const STORAGE_CHANGED_EVENT = "storage-changed";

/** `tau app <path>`: a directory to open, pushed to the window when one is attached. */
export const OPEN_REQUEST_EVENT = "open-request";
export interface OpenRequest {
  workspaceId: string;
  displayPath: string;
  requestedAt: number;
}
/** The CLI's command; the answer says whether a window took it or it waits for one. */
export const APP_OPEN_COMMAND = "app-open";
export interface AppOpenResult {
  workspaceId: string;
  displayPath: string;
  /** A window was attached and got the request. */
  delivered: boolean;
  /** Its window was brought to the front. */
  focused: boolean;
}
/** A window that attaches later takes the request that waited for it. */
export const TAKE_OPEN_REQUEST_COMMAND = "take-open-request";
/** Whether a request waits, asked first: taking nothing would still count as a change a paired device made. */
export const OPEN_REQUEST_WAITING_COMMAND = "open-request-waiting";
