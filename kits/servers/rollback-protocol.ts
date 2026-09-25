// Rolling back a deployment and cleaning up the history; type imports only, so the desktop half may read it.
import type { DeployFilePlan, DeploymentFailure, DeploymentRecord } from "./deploy-protocol.js";

/**
 * One file of a rollback. Outcomes as for an upload: `upload` puts the file
 * back as it was, `delete` removes a file the deployment added, `same`/`gone`
 * the server already holds the old state, `conflict` it holds neither.
 */
export interface RollbackFilePlan extends DeployFilePlan {
  /** The newest later deployment, not rolled back, that wrote this file too. */
  newer?: number;
  /** Three-way: the deployment's change taken out of the server's current file. */
  merged?: boolean;
}

/** `rollback-preview`: what rolling back deployment `seq` would do, read from the server without writing. */
export interface RollbackPreview {
  targetId: string;
  seq: number;
  files: RollbackFilePlan[];
  /** Later deployments, not rolled back, that wrote some of the same files: roll them back first, or merge three-way. */
  newer: number[];
  threeWay: boolean;
}

export interface RollbackResult extends RollbackPreview {
  /** The rollback as a deployment of its own; absent when nothing was written. */
  deployment?: DeploymentRecord;
  failed: DeploymentFailure[];
  /** Every file of `seq` is as before it now, so it counts as rolled back. */
  rolledBack: boolean;
}

/** `cleanup-history`: what one target's cleanup did. */
export interface HistoryCleanupResult {
  targetId: string;
  /** Deployments dropped from the journal with their refs. */
  removed: number[];
  /** Refs a crash left without a journal entry, recorded now. */
  adopted: number[];
  /** Recorded server states older than the kept ones that Git may now prune. */
  truncated: boolean;
  gc: boolean;
}

/** Numbers as a sentence: "3", "3 and 5", "2, 3 and 5". */
export function seqList(seqs: readonly number[]): string {
  if (seqs.length <= 1) return seqs.join("");
  return `${seqs.slice(0, -1).join(", ")} and ${seqs.at(-1)}`;
}
