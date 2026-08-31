import type {
  ChangeStatus,
  UiChangedFile,
  UiDiffHunk,
  UiDiffLine,
  UiFileDiff,
  UiTurnCheckpoint,
  UiWorkspaceChanges,
} from "./contracts.js";

/** Custom entries are part of the Pi session tree and therefore survive reloads and forks. */
export const TURN_CHECKPOINT_CUSTOM_TYPE = "tau.turn-checkpoint.v1";

/**
 * The renderer only receives the small summary. The host keeps the captured
 * diffs in this persisted shape and serves them on demand.
 */
export interface StoredTurnCheckpoint extends UiTurnCheckpoint {
  diffs: Record<string, UiFileDiff>;
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

function diffLine(value: unknown): UiDiffLine | undefined {
  const item = record(value);
  if (!item || (item.kind !== "context" && item.kind !== "added" && item.kind !== "removed")
    || typeof item.text !== "string") return undefined;
  return {
    kind: item.kind,
    ...(finite(item.oldLine) ? { oldLine: item.oldLine } : {}),
    ...(finite(item.newLine) ? { newLine: item.newLine } : {}),
    text: item.text,
  };
}

function diffHunk(value: unknown): UiDiffHunk | undefined {
  const item = record(value);
  if (!item || typeof item.header !== "string" || !Array.isArray(item.lines)) return undefined;
  const lines = item.lines.map(diffLine);
  return lines.every((line): line is UiDiffLine => Boolean(line))
    ? { header: item.header, lines }
    : undefined;
}

function fileDiff(value: unknown, fallbackPath: string): UiFileDiff | undefined {
  const item = record(value);
  if (!item || (typeof item.path !== "string" && fallbackPath.length === 0)
    || !finite(item.added) || !finite(item.removed) || !Array.isArray(item.hunks)) return undefined;
  const hunks = item.hunks.map(diffHunk);
  if (!hunks.every((hunk): hunk is UiDiffHunk => Boolean(hunk))) return undefined;
  return {
    path: typeof item.path === "string" ? item.path : fallbackPath,
    added: Math.max(0, item.added),
    removed: Math.max(0, item.removed),
    hunks,
    ...(typeof item.note === "string" ? { note: item.note } : {}),
    ...(typeof item.truncated === "boolean" ? { truncated: item.truncated } : {}),
    ...(finite(item.nextHunkOffset) ? { nextHunkOffset: item.nextHunkOffset } : {}),
  };
}

function cloneDiff(diff: UiFileDiff): UiFileDiff {
  return {
    ...diff,
    hunks: diff.hunks.map((hunk) => ({
      ...hunk,
      lines: hunk.lines.map((line) => ({ ...line })),
    })),
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
    diffs: Object.fromEntries(Object.entries(checkpoint.diffs).map(([path, diff]) => [path, cloneDiff(diff)])),
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
    || !finite(item.startedAt)
    || !finite(item.endedAt)
    || !Array.isArray(item.files)
    || !finite(item.added)
    || !finite(item.removed)
  ) return undefined;
  const files = item.files.map(changedFile);
  if (!files.every((file): file is UiChangedFile => Boolean(file))) return undefined;
  const rawDiffs = record(item.diffs);
  const diffs: Record<string, UiFileDiff> = {};
  if (rawDiffs) {
    for (const [path, value] of Object.entries(rawDiffs)) {
      const diff = fileDiff(value, path);
      if (diff) diffs[path] = diff;
    }
  }
  const checkpoint: StoredTurnCheckpoint = {
    id: item.id,
    turnId: item.turnId,
    sessionId: item.sessionId,
    anchorMessageId: item.anchorMessageId,
    startedAt: item.startedAt,
    endedAt: item.endedAt,
    files,
    added: Math.max(0, item.added),
    removed: Math.max(0, item.removed),
    ...(typeof item.branch === "string" ? { branch: item.branch } : {}),
    diffs,
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

/** Net worktree changes observed between the start and end of one run. */
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

