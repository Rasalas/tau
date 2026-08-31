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
} from "./turn-checkpoint-types.js";

/** Custom entries are part of the Pi session tree and therefore survive reloads and forks. */
export const TURN_CHECKPOINT_CUSTOM_TYPE = "tau.turn-checkpoint.v1";

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
): StoredTurnCheckpoint {
  return {
    ...cloneStoredTurnCheckpoint(checkpoint),
    sessionId,
    beforeSnapshotId: turnSnapshotRef(sessionId, checkpoint.turnId, "before"),
    afterSnapshotId: turnSnapshotRef(sessionId, checkpoint.turnId, "after"),
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
  };
  return cloneStoredTurnCheckpoint(checkpoint);
}

/** Read checkpoints from the active Pi branch, preserving their append order. */
export function turnCheckpointsFromEntries(
  entries: readonly unknown[],
  sessionId?: string,
): StoredTurnCheckpoint[] {
  const seen = new Set<string>();
  const result: StoredTurnCheckpoint[] = [];
  for (const entry of entries) {
    const item = record(entry);
    if (!item || item.type !== "custom" || item.customType !== TURN_CHECKPOINT_CUSTOM_TYPE) continue;
    const checkpoint = parseStoredTurnCheckpoint(item.data, sessionId);
    if (!checkpoint || seen.has(checkpoint.id)) continue;
    seen.add(checkpoint.id);
    result.push(checkpoint);
  }
  return result;
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
export function boundedTurnCheckpointSummary(changes: UiWorkspaceChanges): Pick<UiTurnCheckpoint, "files" | "fileCount" | "added" | "removed" | "branch"> {
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
