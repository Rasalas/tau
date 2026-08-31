import type {
  ChangeStatus,
  UiChangedFile,
  UiTurnCheckpoint,
  UiWorkspaceChanges,
} from "./contracts.js";
import type {
  StoredTurnCheckpoint,
  TurnCaptureState,
  TurnCheckpointCaptureResult,
  TurnCheckpointBatch,
} from "./turn-checkpoint-types.js";

/** Custom entries are part of the Pi session tree and therefore survive reloads and forks. */
export const TURN_CHECKPOINT_CUSTOM_TYPE = "tau.turn-checkpoint.v1";
/** Journal commit marker for forked checkpoint ref/entry batches. */
export const TURN_CHECKPOINT_BATCH_CUSTOM_TYPE = "tau.turn-checkpoint-batch.v1";

/** Keep the persisted checkpoint small even when a turn changes thousands of files. */
export const MAX_TURN_CHECKPOINT_PREVIEW_FILES = 8;

const SNAPSHOT_REF_PREFIX = "refs/tau/checkpoints";

/** Git ref components are derived from IDs, never accepted as raw arguments. */
export function sanitizeTurnSnapshotComponent(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]/gu, "-");
  if (!sanitized || sanitized === "." || sanitized === ".." || sanitized.includes("..") || sanitized.endsWith(".lock")) {
    throw new Error("Invalid turn checkpoint snapshot namespace.");
  }
  return sanitized;
}

/** Exact ref expected for one session/client-turn/phase tuple. */
export function turnSnapshotRef(
  sessionId: string,
  turnId: string,
  phase: "before" | "after",
): string {
  return `${SNAPSHOT_REF_PREFIX}/${sanitizeTurnSnapshotComponent(sessionId)}/${sanitizeTurnSnapshotComponent(turnId)}/${phase}`;
}

/** Exact ref expected when a caller already has a namespaced session/turn string. */
export function namespacedSnapshotRef(namespace: string, phase: "before" | "after"): string {
  const components = namespace.split("/").map(sanitizeTurnSnapshotComponent);
  if (components.length === 0) throw new Error("Invalid turn checkpoint snapshot namespace.");
  return `${SNAPSHOT_REF_PREFIX}/${components.join("/")}/${phase}`;
}

const SNAPSHOT_ID_PATTERN = /^refs\/tau\/checkpoints\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\/(?:before|after)$/u;

/** Snapshot IDs are refs created by the host, never arbitrary Git arguments. */
export function isTurnSnapshotId(value: unknown): value is string {
  if (typeof value !== "string" || !SNAPSHOT_ID_PATTERN.test(value)) return false;
  const components = value.split("/").slice(3, -1);
  return components.every((component) => component !== "."
    && component !== ".."
    && !component.includes("..")
    && !component.endsWith(".lock"));
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function status(value: unknown): value is ChangeStatus {
  return value === "modified" || value === "added" || value === "deleted"
    || value === "renamed" || value === "untracked";
}

function changedFile(value: unknown): UiChangedFile | undefined {
  const item = record(value);
  if (!item
    || typeof item.path !== "string"
    || typeof item.name !== "string"
    || typeof item.directory !== "string"
    || !status(item.status)
    || !finite(item.added)
    || !finite(item.removed)
  ) return undefined;
  return {
    path: item.path,
    name: item.name,
    directory: item.directory,
    status: item.status,
    added: Math.max(0, item.added),
    removed: Math.max(0, item.removed),
    ...(typeof item.note === "string" && item.note.length > 0 ? { note: item.note.slice(0, 240) } : {}),
  };
}

export function cloneTurnCheckpoint(checkpoint: UiTurnCheckpoint): UiTurnCheckpoint {
  const files = checkpoint.files.slice(0, MAX_TURN_CHECKPOINT_PREVIEW_FILES);
  const fileCount = checkpoint.fileCount === undefined
    ? checkpoint.files.length
    : Math.max(files.length, checkpoint.fileCount);
  return {
    ...checkpoint,
    files: files.map((file) => ({ ...file })),
    fileCount,
  };
}

export function cloneStoredTurnCheckpoint(checkpoint: StoredTurnCheckpoint): StoredTurnCheckpoint {
  return {
    ...cloneTurnCheckpoint(checkpoint),
    beforeSnapshotId: checkpoint.beforeSnapshotId,
    afterSnapshotId: checkpoint.afterSnapshotId,
    ...(checkpoint.transactionId ? { transactionId: checkpoint.transactionId } : {}),
  };
}

/** Compatibility projection for callers that only need the UI-safe summary. */
export function summariesFromStoredTurnCheckpoints(
  checkpoints: readonly StoredTurnCheckpoint[],
): UiTurnCheckpoint[] {
  return checkpoints.map(cloneTurnCheckpoint);
}

/** Re-home an inherited checkpoint while preserving its turn and assistant anchor. */
export function rehomeStoredTurnCheckpoint(
  checkpoint: StoredTurnCheckpoint,
  sessionId: string,
  transactionId?: string,
): StoredTurnCheckpoint {
  const cloned = cloneStoredTurnCheckpoint(checkpoint);
  delete cloned.transactionId;
  return {
    ...cloned,
    sessionId,
    beforeSnapshotId: turnSnapshotRef(sessionId, checkpoint.turnId, "before"),
    afterSnapshotId: turnSnapshotRef(sessionId, checkpoint.turnId, "after"),
    ...(transactionId ? { transactionId } : {}),
  };
}

/** Parse untrusted session data without allowing malformed entries into the UI. */
export function parseStoredTurnCheckpoint(value: unknown, expectedSessionId?: string): StoredTurnCheckpoint | undefined {
  const item = record(value);
  if (!item
    || typeof item.id !== "string"
    || typeof item.turnId !== "string"
    || item.id !== item.turnId
    || typeof item.sessionId !== "string"
    || (expectedSessionId !== undefined && item.sessionId !== expectedSessionId)
    || typeof item.anchorMessageId !== "string"
    || !isTurnSnapshotId(item.beforeSnapshotId)
    || !isTurnSnapshotId(item.afterSnapshotId)
    || !finite(item.startedAt)
    || !finite(item.endedAt)
    || !Array.isArray(item.files)
    || !finite(item.added)
    || !finite(item.removed)
  ) return undefined;
  // A stale/legacy session may contain an unbounded `files` array. Inspect and
  // clone only the preview allowed across the transport seam.
  const files = item.files.slice(0, MAX_TURN_CHECKPOINT_PREVIEW_FILES).map(changedFile);
  if (!files.every((file): file is UiChangedFile => Boolean(file))) return undefined;
  let expectedBefore: string;
  let expectedAfter: string;
  try {
    expectedBefore = turnSnapshotRef(item.sessionId, item.turnId, "before");
    expectedAfter = turnSnapshotRef(item.sessionId, item.turnId, "after");
  } catch {
    return undefined;
  }
  if (item.beforeSnapshotId !== expectedBefore || item.afterSnapshotId !== expectedAfter) return undefined;
  const fileCount = item.fileCount === undefined
    ? item.files.length
    : (typeof item.fileCount === "number" && Number.isSafeInteger(item.fileCount) && item.fileCount >= 0 ? item.fileCount : -1);
  if (fileCount < files.length) return undefined;
  const completeness = item.completeness === undefined
    ? undefined
    : (item.completeness === "complete" || item.completeness === "partial" ? item.completeness : undefined);
  if (item.completeness !== undefined && completeness === undefined) return undefined;
  const omittedFileCount = item.omittedFileCount === undefined
    ? undefined
    : (typeof item.omittedFileCount === "number" && Number.isSafeInteger(item.omittedFileCount) && item.omittedFileCount >= 0
      ? item.omittedFileCount
      : -1);
  if (omittedFileCount === -1) return undefined;
  if (completeness === "partial" && omittedFileCount === undefined) return undefined;
  const checkpoint: StoredTurnCheckpoint = {
    id: item.id,
    turnId: item.turnId,
    sessionId: item.sessionId,
    anchorMessageId: item.anchorMessageId,
    beforeSnapshotId: item.beforeSnapshotId,
    afterSnapshotId: item.afterSnapshotId,
    startedAt: item.startedAt,
    endedAt: item.endedAt,
    files: files.slice(0, MAX_TURN_CHECKPOINT_PREVIEW_FILES),
    fileCount,
    added: Math.max(0, item.added),
    removed: Math.max(0, item.removed),
    ...(typeof item.branch === "string" ? { branch: item.branch } : {}),
    ...(completeness ? { completeness } : {}),
    ...(typeof item.incompleteReason === "string" && item.incompleteReason.length > 0
      ? { incompleteReason: item.incompleteReason.slice(0, 320) }
      : {}),
    ...(omittedFileCount !== undefined ? { omittedFileCount } : {}),
    ...(typeof item.transactionId === "string" && item.transactionId.length > 0
      ? { transactionId: item.transactionId }
      : {}),
  };
  return cloneStoredTurnCheckpoint(checkpoint);
}

/** Read checkpoints from the active Pi branch, preserving their append order. */
export function turnCheckpointsFromEntries(
  entries: readonly unknown[],
  sessionId?: string,
): StoredTurnCheckpoint[] {
  const committedTransactions = committedTurnCheckpointTransactions(entries, sessionId);
  const seen = new Set<string>();
  const result: StoredTurnCheckpoint[] = [];
  for (const entry of entries) {
    const item = record(entry);
    if (!item || item.type !== "custom" || item.customType !== TURN_CHECKPOINT_CUSTOM_TYPE) continue;
    const checkpoint = parseStoredTurnCheckpoint(item.data, sessionId);
    if (checkpoint?.transactionId && !committedTransactions.has(checkpoint.transactionId)) continue;
    if (!checkpoint || seen.has(checkpoint.id)) continue;
    seen.add(checkpoint.id);
    result.push(checkpoint);
  }
  return result;
}

export function parseTurnCheckpointBatch(value: unknown, expectedSessionId?: string): TurnCheckpointBatch | undefined {
  const item = record(value);
  if (!item
    || typeof item.transactionId !== "string"
    || item.transactionId.length === 0
    || typeof item.sessionId !== "string"
    || (expectedSessionId !== undefined && item.sessionId !== expectedSessionId)
    || item.state !== "committed"
    || !Array.isArray(item.checkpointIds)
    || item.checkpointIds.length === 0
    || !item.checkpointIds.every((id): id is string => typeof id === "string" && id.length > 0)
    || new Set(item.checkpointIds).size !== item.checkpointIds.length) return undefined;
  return {
    transactionId: item.transactionId,
    sessionId: item.sessionId,
    checkpointIds: [...item.checkpointIds],
    state: "committed",
  };
}

/**
 * Returns only transactions whose commit marker names every transaction-bound
 * checkpoint record exactly once. A marker by itself is not a commit: this
 * makes a crash between two append operations invisible after restart.
 */
export function committedTurnCheckpointTransactions(
  entries: readonly unknown[],
  sessionId?: string,
): ReadonlySet<string> {
  const records = new Map<string, Array<{ checkpoint: StoredTurnCheckpoint; index: number }>>();
  const batches: Array<{ batch: TurnCheckpointBatch; index: number }> = [];
  for (const [index, entry] of entries.entries()) {
    const item = record(entry);
    if (!item) continue;
    if (item.type === "custom" && item.customType === TURN_CHECKPOINT_CUSTOM_TYPE) {
      const checkpoint = parseStoredTurnCheckpoint(item.data, sessionId);
      if (checkpoint?.transactionId) {
        const transactionRecords = records.get(checkpoint.transactionId) ?? [];
        transactionRecords.push({ checkpoint, index });
        records.set(checkpoint.transactionId, transactionRecords);
      }
    } else if (item.type === "custom" && item.customType === TURN_CHECKPOINT_BATCH_CUSTOM_TYPE) {
      const batch = parseTurnCheckpointBatch(item.data, sessionId);
      if (batch) batches.push({ batch, index });
    }
  }
  const committed = new Set<string>();
  for (const { batch, index } of batches) {
    const recordsForTransaction = records.get(batch.transactionId);
    if (!recordsForTransaction || recordsForTransaction.length !== batch.checkpointIds.length) continue;
    const checkpointIds = new Set(batch.checkpointIds);
    // The marker is an append-only commit point, not merely a set-membership
    // hint. Records written after it belong to a later/recovered attempt and
    // must not make an earlier partial batch appear committed.
    if (recordsForTransaction.every(({ checkpoint, index: recordIndex }) => checkpointIds.has(checkpoint.id)
      && checkpoint.sessionId === batch.sessionId
      && recordIndex < index)
      && new Set(recordsForTransaction.map(({ checkpoint }) => checkpoint.id)).size === checkpointIds.size) {
      committed.add(batch.transactionId);
    }
  }
  return committed;
}

/** Creates the final journal record after every cloned entry has been appended. */
export function createTurnCheckpointBatch(
  transactionId: string,
  sessionId: string,
  checkpointIds: readonly string[],
): TurnCheckpointBatch {
  if (!transactionId || !sessionId || checkpointIds.length === 0 || checkpointIds.some((id) => !id)
    || new Set(checkpointIds).size !== checkpointIds.length) {
    throw new Error("Invalid turn checkpoint fork transaction.");
  }
  return {
    transactionId,
    sessionId,
    checkpointIds: [...checkpointIds],
    state: "committed",
  };
}

/** Keep inherited cards only when their assistant anchor is on the fork branch. */
export function checkpointsForBranch(
  entries: readonly unknown[],
  checkpoints: readonly StoredTurnCheckpoint[],
): StoredTurnCheckpoint[] {
  const entryIds = new Set(entries.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const id = (entry as { id?: unknown }).id;
    return typeof id === "string" ? [id] : [];
  }));
  return checkpoints.filter((checkpoint) => entryIds.has(checkpoint.anchorMessageId));
}

/** Convert a full Git summary into the only file data allowed in a checkpoint entry. */
export function boundedTurnCheckpointSummary(changes: UiWorkspaceChanges): Pick<UiTurnCheckpoint, "files" | "fileCount" | "added" | "removed" | "branch" | "completeness" | "incompleteReason" | "omittedFileCount"> {
  const files = changes.files.slice(0, MAX_TURN_CHECKPOINT_PREVIEW_FILES);
  const fileCount = changes.fileCount === undefined
    ? changes.files.length
    : (Number.isSafeInteger(changes.fileCount) && changes.fileCount >= files.length
      ? changes.fileCount
      : changes.files.length);
  return {
    ...(changes.branch ? { branch: changes.branch } : {}),
    files: files.map((file) => ({ ...file })),
    fileCount,
    added: Math.max(0, changes.added),
    removed: Math.max(0, changes.removed),
    ...(changes.completeness ? { completeness: changes.completeness } : {}),
    ...(changes.incompleteReason ? { incompleteReason: changes.incompleteReason.slice(0, 320) } : {}),
    ...(changes.completeness === "partial" || changes.omittedFileCount !== undefined
      ? { omittedFileCount: Math.max(0, changes.omittedFileCount ?? 0) }
      : {}),
  };
}

/** Canonical durable record construction shared by the host and Pi bridge. */
export function createStoredTurnCheckpoint<Snapshot extends { id: string }>(
  result: TurnCheckpointCaptureResult<Snapshot>,
  capture: Pick<TurnCaptureState<Snapshot>, "id" | "startedAt">,
  sessionId: string,
): StoredTurnCheckpoint {
  const expectedBefore = turnSnapshotRef(sessionId, capture.id, "before");
  const expectedAfter = turnSnapshotRef(sessionId, capture.id, "after");
  if (result.beforeSnapshot.id !== expectedBefore || result.afterSnapshot.id !== expectedAfter) {
    throw new Error("Turn checkpoint snapshot refs do not match the capture namespace.");
  }
  return {
    id: capture.id,
    turnId: capture.id,
    sessionId,
    anchorMessageId: result.anchorMessageId,
    beforeSnapshotId: result.beforeSnapshot.id,
    afterSnapshotId: result.afterSnapshot.id,
    startedAt: capture.startedAt,
    endedAt: result.endedAt,
    ...boundedTurnCheckpointSummary(result.changes),
  };
}

export type { StoredTurnCheckpoint } from "./turn-checkpoint-types.js";
