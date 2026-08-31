import type {
  ChangeStatus,
  DiffLoadOptions,
  UiChangedFile,
  UiTurnCheckpoint,
  UiWorkspaceChanges,
} from "./contracts.js";

/** Custom entries are part of the Pi session tree and therefore survive reloads and forks. */
export const TURN_CHECKPOINT_CUSTOM_TYPE = "tau.turn-checkpoint.v1";

/**
 * A persisted checkpoint contains only immutable snapshot references and a
 * bounded summary. The file patch is deliberately not stored here: it is read
 * from Git when the user opens one file in the historical review.
 */
export interface StoredTurnCheckpoint extends UiTurnCheckpoint {
  beforeSnapshotId: string;
  afterSnapshotId: string;
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

export type TurnOutcome = "completed" | "aborted" | "error";

/**
 * Shared lifecycle state used by both the embedded host and the Pi bridge.
 * `Snapshot` is intentionally opaque to this transport-neutral module: the
 * host-side Git adapter owns how a snapshot is captured and addressed.
 */
export interface TurnCaptureState<Snapshot = unknown> {
  id: string;
  startedAt: number;
  beforeSnapshot: Promise<Snapshot | undefined>;
  /** Set once the runtime has accepted the prompt and emitted agent_start. */
  started?: boolean;
  outcome?: TurnOutcome;
  lastAssistant?: { stopReason?: string; timestamp?: number };
}

export interface TurnOutcomeEvent {
  messages?: readonly unknown[];
  willRetry?: boolean;
}

export interface TurnCheckpointCaptureResult<Snapshot> {
  beforeSnapshot: Snapshot;
  afterSnapshot: Snapshot;
  changes: UiWorkspaceChanges;
  anchorMessageId: string;
  endedAt: number;
}

/** Shared before-boundary creation used by both the desktop host and bridge. */
export function startTurnCapture<Snapshot>(
  id: string,
  startedAt: number,
  createBeforeSnapshot: () => Promise<Snapshot | undefined>,
  onError?: (error: unknown) => void,
): TurnCaptureState<Snapshot> {
  const beforeSnapshot = Promise.resolve()
    .then(createBeforeSnapshot)
    .catch((error) => {
      onError?.(error);
      return undefined;
    });
  return { id, startedAt, beforeSnapshot, started: false };
}

/**
 * Shared after-boundary and summary lifecycle. Transports provide only their
 * Git adapter and durable assistant anchor; no wire/session implementation is
 * coupled to this module.
 */
export async function completeTurnCapture<Snapshot>(
  capture: TurnCaptureState<Snapshot>,
  options: {
    createAfterSnapshot: () => Promise<Snapshot | undefined>;
    summarize: (before: Snapshot, after: Snapshot) => Promise<UiWorkspaceChanges>;
    anchorMessageId?: string;
  },
): Promise<TurnCheckpointCaptureResult<Snapshot> | undefined> {
  if (!shouldPersistTurnCapture(capture)) return undefined;
  const beforeSnapshot = await capture.beforeSnapshot;
  if (!beforeSnapshot || !options.anchorMessageId) return undefined;
  const afterSnapshot = await options.createAfterSnapshot();
  if (!afterSnapshot) return undefined;
  return {
    beforeSnapshot,
    afterSnapshot,
    changes: await options.summarize(beforeSnapshot, afterSnapshot),
    anchorMessageId: options.anchorMessageId,
    endedAt: Date.now(),
  };
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
  return {
    ...checkpoint,
    files: checkpoint.files.map((file) => ({ ...file })),
  };
}

export function cloneStoredTurnCheckpoint(checkpoint: StoredTurnCheckpoint): StoredTurnCheckpoint {
  return {
    ...cloneTurnCheckpoint(checkpoint),
    beforeSnapshotId: checkpoint.beforeSnapshotId,
    afterSnapshotId: checkpoint.afterSnapshotId,
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
  const files = item.files.map(changedFile);
  if (!files.every((file): file is UiChangedFile => Boolean(file))) return undefined;
  const checkpoint: StoredTurnCheckpoint = {
    id: item.id,
    turnId: item.turnId,
    sessionId: item.sessionId,
    anchorMessageId: item.anchorMessageId,
    beforeSnapshotId: item.beforeSnapshotId,
    afterSnapshotId: item.afterSnapshotId,
    startedAt: item.startedAt,
    endedAt: item.endedAt,
    files,
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

export function summariesFromStoredTurnCheckpoints(
  checkpoints: readonly StoredTurnCheckpoint[],
): UiTurnCheckpoint[] {
  return checkpoints.map(cloneTurnCheckpoint);
}

function fileEqual(left: UiChangedFile | undefined, right: UiChangedFile): boolean {
  return Boolean(left
    && left.status === right.status
    && left.added === right.added
    && left.removed === right.removed);
}

function turnStats(before: UiChangedFile | undefined, after: UiChangedFile): { added: number; removed: number } {
  if (!before) return { added: after.added, removed: after.removed };
  const addedDelta = after.added - before.added;
  const removedDelta = after.removed - before.removed;
  return {
    added: Math.max(0, addedDelta) + Math.max(0, -removedDelta),
    removed: Math.max(0, removedDelta) + Math.max(0, -addedDelta),
  };
}

/** Legacy renderer activity helper; persisted checkpoints use Git snapshots instead. */
export function changesSinceTurn(
  baseline: UiWorkspaceChanges | undefined,
  current: UiWorkspaceChanges,
): UiWorkspaceChanges {
  if (!baseline) return { branch: current.branch, files: [], added: 0, removed: 0 };
  const beforeByPath = new Map(baseline.files.map((file) => [file.path, file]));
  const files = current.files.flatMap((file) => {
    const before = beforeByPath.get(file.path);
    if (fileEqual(before, file)) return [];
    return [{ ...file, ...turnStats(before, file) }];
  });
  return {
    branch: current.branch,
    refreshStatus: current.refreshStatus,
    files,
    added: files.reduce((total, file) => total + file.added, 0),
    removed: files.reduce((total, file) => total + file.removed, 0),
  };
}

/**
 * Keep diff paging bounded at the shared seam. Both host implementations pass
 * these values to the Git adapter, which loads exactly the requested file.
 */
export function normalizeDiffLoadOptions(
  options: DiffLoadOptions | undefined,
  maxHunks: number,
): Required<DiffLoadOptions> {
  const offset = Number.isFinite(options?.hunkOffset) ? Math.max(0, Math.floor(options?.hunkOffset ?? 0)) : 0;
  const limit = Number.isFinite(options?.hunkLimit)
    ? Math.min(maxHunks, Math.max(1, Math.floor(options?.hunkLimit ?? maxHunks)))
    : maxHunks;
  return { hunkOffset: offset, hunkLimit: limit };
}

function assistantFromMessages(messages: readonly unknown[]): { stopReason?: string; timestamp?: number } | undefined {
  const message = [...messages].reverse().map(record).find((candidate) => candidate?.role === "assistant");
  if (!message) return undefined;
  return {
    ...(typeof message.stopReason === "string" ? { stopReason: message.stopReason } : {}),
    ...(finite(message.timestamp) ? { timestamp: message.timestamp } : {}),
  };
}

/** Shared outcome semantics: retries keep one turn identity until a final result. */
export function recordTurnOutcome<Snapshot>(capture: TurnCaptureState<Snapshot>, event: TurnOutcomeEvent): void {
  const assistant = assistantFromMessages(event.messages ?? []);
  if (event.willRetry) capture.outcome = undefined;
  if (!assistant) return;
  capture.lastAssistant = assistant;
  if (event.willRetry) {
    return;
  } else if (assistant.stopReason === "aborted") {
    capture.outcome = "aborted";
  } else if (assistant.stopReason === "error") {
    capture.outcome = "error";
  } else {
    capture.outcome = "completed";
  }
}

/** Keep only the small assistant marker needed for lifecycle diagnostics. */
export function recordTurnAssistant<Snapshot>(capture: TurnCaptureState<Snapshot>, message: unknown): void {
  const item = record(message);
  if (item?.role !== "assistant") return;
  capture.lastAssistant = {
    ...(typeof item.stopReason === "string" ? { stopReason: item.stopReason } : {}),
    ...(finite(item.timestamp) ? { timestamp: item.timestamp } : {}),
  };
}

export function shouldPersistTurnCapture<Snapshot>(capture: TurnCaptureState<Snapshot>): boolean {
  return capture.started === true && capture.outcome === "completed";
}
