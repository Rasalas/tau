import type { UiWorkspaceChanges } from "tau/host-extension";
import type { GitRunner, SnapshotGitRunner } from "./git-command.js";
import type { StoredTurnCheckpoint, TurnRestoreBackup } from "./turn-checkpoint-codec.js";
import type { TurnRestoreTransaction } from "./turn-checkpoint-types.js";

export interface WorkspaceSnapshot {
  /** Stable namespaced ref persisted in the turn checkpoint. */
  id: string;
  ref: string;
  /** The tree object addressed by the ref, useful for diagnostics and tests. */
  treeId: string;
  /** Capture location/identity, used to clean provisional refs after a switch. */
  cwd?: string;
  sessionId?: string;
  turnId?: string;
  phase?: "before" | "after";
  /** Plain folders use the bounded filesystem content-addressed backend. */
  backend?: "git" | "filesystem";
  /** Plain-folder snapshots are restorable only when the bounded scan completed. */
  complete?: boolean;
  /** HEAD when the tree was read ("" while unborn); Git snapshots only. */
  head?: string;
  headBranch?: string;
}

export interface WorkspaceSnapshotOptions {
  /** Session/turn namespace. It must not contain an empty or `..` component. */
  namespace: string;
  phase: "before" | "after";
  runGit?: SnapshotGitRunner;
}

export interface SnapshotDiffOptions {
  branch?: string;
  runGit?: GitRunner;
  expected?: SnapshotRefExpectation;
}

export interface SnapshotRefExpectation {
  sessionId: string;
  turnId: string;
}

export interface SnapshotPageOptions extends SnapshotRefExpectation {
  branch?: string;
  cursor?: string;
  limit?: number;
  runGit?: GitRunner;
  /** Narrows the full list to the turn's own files before it is paged. */
  attribute?(changes: UiWorkspaceChanges): Promise<UiWorkspaceChanges>;
}

export interface WorkspaceRestoreOptions {
  /** The checkpoint whose `after` tree becomes the live workspace. */
  target: SnapshotRefExpectation;
  /** A complete pair captured immediately before restore, used for rollback. */
  rollback: SnapshotRefExpectation;
  runGit?: GitRunner;
  /** Durable phase hook; called before/inside/after the destructive apply. */
  onPhase?: (phase: "apply-started" | "cleaned" | "applied" | "rolling-back") => void | Promise<void>;
}

/**
 * How long a snapshot ref survives an orphan sweep whatever the journals say.
 * Publishing the refs and appending the durable entry are two steps, and no
 * lease spans the gap once capture has released; a sweep that lands inside it
 * would otherwise read a complete checkpoint as garbage.
 */
export const CHECKPOINT_REF_GRACE_MS = 10 * 60 * 1_000;

export interface CheckpointRefSweepOptions {
  /** Zero disables the age backstop, leaving the journals as the only roots. */
  graceMs?: number;
  now?: number;
}

export interface LiveCheckpointSession {
  sessionId: string;
  checkpoints: readonly StoredTurnCheckpoint[];
  backups?: readonly TurnRestoreBackup[];
  /** Pending restore transactions own rollback refs until recovery commits. */
  restoreTransactions?: readonly TurnRestoreTransaction[];
  /** Canonical workspace used to scope GC when linked worktrees share refs. */
  cwd?: string;
}
