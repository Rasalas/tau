// Deployments as the host half records and answers them; type imports only, so the desktop half may read it.
// Paths are relative to the target: its `remotePath` on the server, its `context` folder locally.
import type { DeploymentStatus } from "./protocol.js";

/** Emitted with `{ workspace, targetId, seq? }` once a deployment or a resolved conflict changed a target. */
export const DEPLOY_EVENT = "deployed";

/** What an upload does to one file on the server. */
export type DeployOp = "add" | "modify" | "delete";

/** One file the user chose; `op` is what the upload list showed for it. */
export interface DeployRequestFile {
  path: string;
  op: DeployOp;
}

/**
 * What becomes of a chosen file, decided against the server as it is now
 * (three-way: the mirror state is the base, the local file ours, the server theirs).
 * - `upload`, `delete`: the server still holds the mirror state; the change goes up.
 * - `same`: the server already holds the local content; nothing is written.
 * - `gone`: a deletion the server already lacks.
 * - `conflict`: the server changed since Tau last read it; never overwritten without the user's word.
 * - `blocked`: Tau does not upload it (why in `reason`).
 * - `stale`: no longer pending as chosen; the list changed meanwhile.
 */
export type DeployOutcome = "upload" | "delete" | "same" | "gone" | "conflict" | "blocked" | "stale";

export interface DeployStamp {
  size: number;
  /** Seconds since the epoch. */
  mtime: number;
  mode: number;
}

export interface DeployFilePlan {
  path: string;
  op: DeployOp;
  outcome: DeployOutcome;
  reason?: string;
  /** The server's file as read now; absent when it has none. */
  server?: DeployStamp;
  /** The user said "overwrite anyway" to this conflict. */
  forced?: boolean;
}

/** `deploy-preview`: what an upload of the chosen files would do, read from the server without writing. */
export interface DeployPreview {
  targetId: string;
  files: DeployFilePlan[];
  /** Local deletions the user left out: they stay on the server and stay pending. */
  kept: string[];
  /** Worth a look before confirming, such as a file the last deployment took from another branch. */
  warnings: string[];
}

/** One file a deployment changed on the server, with the blobs (in the shadow repository) that undo it. */
export interface DeploymentFile {
  path: string;
  op: DeployOp;
  /** The server's content before, as read right before writing; absent for a new file. */
  before?: string;
  beforeMode?: number;
  /** What went up; absent for a deletion. */
  after?: string;
  mode?: number;
  /** `in-place`: the folder took no temp file, so the file was rewritten where it stands. */
  written?: "rename" | "in-place";
}

export interface DeploymentFailure {
  path: string;
  op: DeployOp;
  message: string;
}

/**
 * Who started it. Always the user: the agent proposes, it never uploads (ADR 0028).
 * `threadId` is the thread whose work went up, when there was one.
 */
export interface DeploymentOrigin {
  actor: "user";
  via: "view" | "card";
  threadId?: string;
}

export interface DeploymentCheckout {
  /** The checkout the files came from: the main checkout or a worktree. */
  path: string;
  branch?: string;
  head?: string;
}

/** One entry of `deployments.json`. `refs/tau/deploy/<seq>` in the shadow repository keeps its blobs. */
export interface DeploymentRecord {
  seq: number;
  /** `rollback` undoes deployment `rollbackOf` (I11); it is a deployment of its own. */
  kind: "upload" | "rollback";
  rollbackOf?: number;
  /** ISO time. */
  at: string;
  origin: DeploymentOrigin;
  checkout: DeploymentCheckout;
  /** The target's folder in the project, `""` for its root, to find the files in a commit. */
  context: string;
  files: DeploymentFile[];
  failed: DeploymentFailure[];
  /** Chosen files that did not go: conflicts, blocked, already there. */
  skipped: DeployFilePlan[];
  status: DeploymentStatus;
  /** On `refs/tau/deploy/<seq>`: tree = the server after, parent = the server before. */
  commit: string;
  /** The mirror state this deployment recorded (`refs/tau/server`). */
  mirrorCommit: string;
  note?: string;
}

/** `deploy`: what went through, what did not, and why. */
export interface DeployResult {
  targetId: string;
  /** Absent when nothing went through; nothing is recorded then. */
  deployment?: DeploymentRecord;
  files: DeployFilePlan[];
  failed: DeploymentFailure[];
}

/** `deploy-resolve` on a conflict: take the server's file locally, or merge it into the local one with conflict markers. */
export type DeployResolveAction = "take-server" | "merge";

export interface DeployResolveResult {
  path: string;
  action: DeployResolveAction;
  /** For a merge: the number of conflicts `git merge-file` left marked in the local file. */
  conflicts: number;
  /** The server had deleted the file; taking it deleted the local one. */
  deleted?: boolean;
}

export const DEPLOY_OP_WORDS: Readonly<Record<DeployOp, string>> = { add: "new", modify: "changed", delete: "deleted" };

/** "3 changed, 1 deleted"; empty for no files. */
export function deployCounts(files: readonly { op: DeployOp }[]): string {
  const deleted = files.filter((file) => file.op === "delete").length;
  const changed = files.length - deleted;
  return [changed ? `${changed} changed` : "", deleted ? `${deleted} deleted` : ""].filter(Boolean).join(", ");
}

/** "Upload: 3 changed, 1 deleted" for what a plan writes; "Upload" when it writes nothing. */
export function planSummary(files: readonly Pick<DeployFilePlan, "outcome" | "forced" | "op">[]): { changed: number; deleted: number; label: string } {
  const writes = files.filter((file) => file.outcome === "upload" || file.outcome === "delete" || (file.outcome === "conflict" && file.forced));
  const deleted = writes.filter((file) => file.op === "delete").length;
  const counts = deployCounts(writes);
  return { changed: writes.length - deleted, deleted, label: counts ? `Upload: ${counts}` : "Upload" };
}

const OPS = new Set<DeployOp>(["add", "modify", "delete"]);
export const isDeployOp = (value: unknown): value is DeployOp => typeof value === "string" && OPS.has(value as DeployOp);
