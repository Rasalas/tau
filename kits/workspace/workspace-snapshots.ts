import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { DiffLoadOptions, UiFileDiff, UiWorkspaceChanges, UiWorkspaceChangesPage } from "tau/host-extension";
import { runGitCommand as git, type GitRunner, type SnapshotGitRunner } from "./git-command.js";
import {
  isTurnSnapshotId,
  namespacedSnapshotRef,
  sanitizeTurnSnapshotComponent,
  turnSnapshotRef,
  type StoredTurnCheckpoint,
  type TurnRestoreBackup,
} from "./turn-checkpoint-codec.js";
import { listLiveWorkspaceLeaseSessions } from "./workspace-checkpoint-lease.js";
import { assertWorkspacePath } from "./workspace-paths.js";
import { filesystemSnapshotAdapter } from "./filesystem-snapshot-adapter.js";
import { gitSnapshotAdapter } from "./git-snapshot-adapter.js";
import type { SnapshotAdapter, SnapshotPair, SnapshotObjects } from "./snapshot-adapter.js";
import type {
  WorkspaceSnapshot,
  WorkspaceSnapshotOptions,
  SnapshotRefExpectation,
  SnapshotDiffOptions,
  SnapshotPageOptions,
  WorkspaceRestoreOptions,
  CheckpointRefSweepOptions,
  LiveCheckpointSession,
} from "./workspace-snapshot-types.js";

export type {
  WorkspaceSnapshot,
  WorkspaceSnapshotOptions,
  SnapshotRefExpectation,
  SnapshotDiffOptions,
  SnapshotPageOptions,
  WorkspaceRestoreOptions,
  CheckpointRefSweepOptions,
  LiveCheckpointSession,
} from "./workspace-snapshot-types.js";
export { CHECKPOINT_REF_GRACE_MS } from "./workspace-snapshot-types.js";
export { gcFilesystemSnapshotBlobs } from "./filesystem-snapshot-adapter.js";

/**
 * Snapshot operations own exact namespaces, immutable pairs, rollback and
 * retention. Callers hold the workspace lease and durably retain rollback refs
 * before restore. Adapters own storage and never decide which sessions survive.
 */
async function snapshotPair(cwd: string, before: string, after: string, runGit: GitRunner, validate: boolean): Promise<{ adapter: SnapshotAdapter; pair: SnapshotPair }> {
  const filesystem = filesystemSnapshotAdapter(cwd);
  const stored = await filesystem.pair(before, after, validate);
  if (stored) return { adapter: filesystem, pair: stored };
  const adapter = gitSnapshotAdapter(cwd, runGit);
  const pair = await adapter.pair(before, after, validate);
  if (!pair) throw new Error("Turn checkpoint snapshot refs are unavailable.");
  return { adapter, pair };
}

function assertExpectedPair(before: string, after: string, expected: SnapshotRefExpectation): void {
  if (before !== turnSnapshotRef(expected.sessionId, expected.turnId, "before")
    || after !== turnSnapshotRef(expected.sessionId, expected.turnId, "after")) {
    throw new Error("Turn checkpoint snapshot refs do not match their session and turn.");
  }
}

export async function createWorkspaceSnapshot(cwd: string, options: WorkspaceSnapshotOptions): Promise<WorkspaceSnapshot> {
  const ref = namespacedSnapshotRef(options.namespace, options.phase);
  const snapshot = await gitSnapshotAdapter(cwd, options.runGit).capture(options, ref)
    ?? await filesystemSnapshotAdapter(cwd).capture(options, ref);
  if (!snapshot) throw new Error("Workspace snapshots are unavailable.");
  return snapshot;
}

/** Turn-specific wrapper that makes the persisted ref name derivation explicit. */
export async function createTurnWorkspaceSnapshot(
  cwd: string,
  sessionId: string,
  turnId: string,
  phase: "before" | "after",
  runGit?: SnapshotGitRunner,
): Promise<WorkspaceSnapshot> {
  const snapshot = await createWorkspaceSnapshot(cwd, {
    namespace: `${sanitizeTurnSnapshotComponent(sessionId)}/${sanitizeTurnSnapshotComponent(turnId)}`,
    phase,
    ...(runGit ? { runGit } : {}),
  });
  return { ...snapshot, cwd, sessionId, turnId, phase };
}

/** Structural validation supports historical reads even when filesystem coverage was partial. */
export async function validateWorkspaceSnapshotRefs(
  cwd: string, before: string, after: string, expected: SnapshotRefExpectation, runGit: GitRunner = git,
): Promise<{ beforeTreeId: string; afterTreeId: string }> {
  assertExpectedPair(before, after, expected);
  const { pair } = await snapshotPair(cwd, before, after, runGit, true);
  return { beforeTreeId: pair.beforeTreeId, afterTreeId: pair.afterTreeId };
}

/** Restore additionally requires complete coverage, mode metadata and verified historical bytes. */
export async function validateRestorableWorkspaceSnapshotRefs(
  cwd: string, before: string, after: string, expected: SnapshotRefExpectation, runGit: GitRunner = git,
): Promise<{ beforeTreeId: string; afterTreeId: string }> {
  assertExpectedPair(before, after, expected);
  const { pair } = await snapshotPair(cwd, before, after, runGit, true);
  await pair.assertRestorable("Selected checkpoint");
  return { beforeTreeId: pair.beforeTreeId, afterTreeId: pair.afterTreeId };
}

/** A failed apply always attempts the verified rollback pair, including failures in phase hooks. */
export async function restoreWorkspaceSnapshot(cwd: string, targetAfterSnapshotId: string, options: WorkspaceRestoreOptions): Promise<void> {
  const targetBefore = turnSnapshotRef(options.target.sessionId, options.target.turnId, "before");
  const targetAfter = turnSnapshotRef(options.target.sessionId, options.target.turnId, "after");
  const rollbackBefore = turnSnapshotRef(options.rollback.sessionId, options.rollback.turnId, "before");
  const rollbackAfter = turnSnapshotRef(options.rollback.sessionId, options.rollback.turnId, "after");
  if (targetAfterSnapshotId !== targetAfter) throw new Error("The selected checkpoint snapshot does not match its session and turn.");
  const runGit = options.runGit ?? git;
  const [target, rollback] = await Promise.all([
    snapshotPair(cwd, targetBefore, targetAfter, runGit, true),
    snapshotPair(cwd, rollbackBefore, rollbackAfter, runGit, true),
  ]);
  if (target.adapter.kind !== rollback.adapter.kind) throw new Error("The checkpoint and rollback snapshots use different workspace backends.");
  await target.pair.assertRestorable("Selected checkpoint");
  await rollback.pair.assertRestorable("Restore backup");
  try {
    await options.onPhase?.("apply-started");
    await target.pair.applyAfter(() => options.onPhase?.("cleaned"));
    await options.onPhase?.("applied");
  } catch (error) {
    await Promise.resolve().then(() => options.onPhase?.("rolling-back")).catch(() => undefined);
    try {
      await rollback.pair.applyAfter();
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "Workspace restore failed and rollback could not be completed.", { cause: rollbackError });
    }
    throw new Error(`Workspace restore failed; the original workspace was restored. ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

function snapshotPairShape(
  beforeSnapshotId: string,
  afterSnapshotId: string,
): { namespace: string } | undefined {
  if (!isTurnSnapshotId(beforeSnapshotId) || !isTurnSnapshotId(afterSnapshotId)) return undefined;
  const beforeParts = beforeSnapshotId.split("/");
  const afterParts = afterSnapshotId.split("/");
  const beforePhase = beforeParts.at(-1);
  const afterPhase = afterParts.at(-1);
  const beforeNamespace = beforeParts.slice(3, -1).join("/");
  const afterNamespace = afterParts.slice(3, -1).join("/");
  if (beforePhase !== "before" || afterPhase !== "after" || beforeNamespace !== afterNamespace) return undefined;
  return { namespace: beforeNamespace };
}

/**
 * Forks inherit the conversation tree, but their checkpoint refs must live in
 * the new session namespace. Copy the immutable tree targets atomically and
 * remove only refs created by this operation if the second phase fails.
 */
export async function cloneTurnCheckpointRefs(
  cwd: string,
  sourceSessionId: string,
  targetSessionId: string,
  checkpoints: readonly StoredTurnCheckpoint[],
  runGit: GitRunner = git,
): Promise<void> {
  const created: Array<{ id: string; treeId: string }> = [];
  try {
    for (const checkpoint of checkpoints) {
      if (checkpoint.sessionId !== sourceSessionId
        || checkpoint.beforeSnapshotId !== turnSnapshotRef(sourceSessionId, checkpoint.turnId, "before")
        || checkpoint.afterSnapshotId !== turnSnapshotRef(sourceSessionId, checkpoint.turnId, "after")) {
        throw new Error("Cannot clone a checkpoint with a foreign snapshot namespace.");
      }
      const { pair } = await snapshotPair(cwd, checkpoint.beforeSnapshotId, checkpoint.afterSnapshotId, runGit, true);
      for (const [phase, treeId] of [["before", pair.beforeTreeId], ["after", pair.afterTreeId]] as const) {
        const id = turnSnapshotRef(targetSessionId, checkpoint.turnId, phase);
        if (await pair.clone(phase, id)) created.push({ id, treeId });
      }
      await validateWorkspaceSnapshotRefs(
        cwd,
        turnSnapshotRef(targetSessionId, checkpoint.turnId, "before"),
        turnSnapshotRef(targetSessionId, checkpoint.turnId, "after"),
        { sessionId: targetSessionId, turnId: checkpoint.turnId },
        runGit,
      );
    }
  } catch (error) {
    await Promise.all(created.map(({ id, treeId }) => deleteWorkspaceSnapshot(
      cwd,
      id,
      { sessionId: targetSessionId, turnId: id.split("/").at(-2) ?? "", phase: id.endsWith("/after") ? "after" : "before", treeId },
      runGit,
    )));
    throw error;
  }
}

/** Removes only target refs whose trees match the source fork copy. */
export async function cleanupClonedTurnCheckpointRefs(
  cwd: string,
  sourceSessionId: string,
  targetSessionId: string,
  checkpoints: readonly StoredTurnCheckpoint[],
  runGit: GitRunner = git,
  /** Already committed target entries survive a failed/retried fork. */
  preserve: readonly StoredTurnCheckpoint[] = [],
): Promise<void> {
  const preserved = new Set(preserve.flatMap((checkpoint) => [checkpoint.beforeSnapshotId, checkpoint.afterSnapshotId]));
  await Promise.all(checkpoints.map(async (checkpoint) => {
    if (checkpoint.sessionId !== sourceSessionId) return;
    const source = await validateWorkspaceSnapshotRefs(
      cwd,
      checkpoint.beforeSnapshotId,
      checkpoint.afterSnapshotId,
      { sessionId: sourceSessionId, turnId: checkpoint.turnId },
      runGit,
    ).catch(() => undefined);
    const before = turnSnapshotRef(targetSessionId, checkpoint.turnId, "before");
    const after = turnSnapshotRef(targetSessionId, checkpoint.turnId, "after");
    // Normally the source pair supplies tree IDs for compare-and-delete. If a
    // source session was removed during failure recovery, the target refs are
    // still uncommitted by definition; remove only the exact target namespace
    // while preserving every durable target entry supplied by `preserve`.
    // This avoids leaving orphaned fork refs merely because the source cleanup
    // raced the recovery path.
    if (!preserved.has(before)) {
      await deleteWorkspaceSnapshot(
        cwd,
        before,
        source
          ? { sessionId: targetSessionId, turnId: checkpoint.turnId, phase: "before", treeId: source.beforeTreeId }
          : { sessionId: targetSessionId, turnId: checkpoint.turnId, phase: "before" },
        runGit,
      );
    }
    if (!preserved.has(after)) {
      await deleteWorkspaceSnapshot(
        cwd,
        after,
        source
          ? { sessionId: targetSessionId, turnId: checkpoint.turnId, phase: "after", treeId: source.afterTreeId }
          : { sessionId: targetSessionId, turnId: checkpoint.turnId, phase: "after" },
        runGit,
      );
    }
  }));
}

/** Delete only an exact namespaced ref, optionally guarded by its immutable tree. */
export async function deleteWorkspaceSnapshot(
  cwd: string,
  snapshotId: string,
  expected?: SnapshotRefExpectation & { phase?: "before" | "after"; treeId?: string },
  runGit: GitRunner = git,
): Promise<void> {
  if (!isTurnSnapshotId(snapshotId)) return;
  if (expected) {
    const phase = expected.phase ?? (snapshotId.endsWith("/after") ? "after" : "before");
    if (snapshotId !== turnSnapshotRef(expected.sessionId, expected.turnId, phase)) return;
  }
  const filesystem = filesystemSnapshotAdapter(cwd);
  if (await filesystem.pair(snapshotId, snapshotId, false)) {
    await filesystem.remove(snapshotId, expected?.treeId);
  } else {
    await gitSnapshotAdapter(cwd, runGit).remove(snapshotId, expected?.treeId);
  }
}

/** Session/pruning hook: remove all refs owned by a completed checkpoint. */
export async function cleanupTurnCheckpointRefs(
  cwd: string,
  checkpoints: readonly SnapshotRefExpectation[],
  runGit: GitRunner = git,
): Promise<void> {
  for (const checkpoint of checkpoints) {
    await deleteWorkspaceSnapshot(cwd, turnSnapshotRef(checkpoint.sessionId, checkpoint.turnId, "before"), checkpoint, runGit);
    await deleteWorkspaceSnapshot(cwd, turnSnapshotRef(checkpoint.sessionId, checkpoint.turnId, "after"), { ...checkpoint, phase: "after" }, runGit);
  }
}

/** Actual session deletion releases all its refs, independent of the orphan grace period. */
export async function cleanupTurnCheckpointSessionRefs(cwd: string, sessionId: string, runGit: GitRunner = git): Promise<void> {
  const id = sanitizeTurnSnapshotComponent(sessionId);
  for (const adapter of [gitSnapshotAdapter(cwd, runGit), filesystemSnapshotAdapter(cwd)]) {
    await adapter.removeSession(id);
    await adapter.gc();
  }
}

function listedTreePair(objects: SnapshotObjects, before: string, after: string): boolean {
  return [before, after].every((ref) => {
    const object = objects.get(ref);
    return object?.type === "tree" && object.id !== undefined && /^[0-9a-f]{40,64}$/iu.test(object.id.trim());
  });
}

/** Pair publication and journal append are separate writes. Incomplete pairs need the same grace as complete ones. */
async function sweepAdapter(
  adapter: SnapshotAdapter,
  prefix: string,
  sessions: readonly LiveCheckpointSession[],
  options: CheckpointRefSweepOptions,
  protectedSessions?: () => Promise<Set<string>>,
): Promise<void> {
  const protectedIds = await protectedSessions?.() ?? new Set<string>();
  const objects = await adapter.objects(prefix);
  const refreshProtection = async () => {
    for (const id of await protectedSessions?.() ?? []) protectedIds.add(id);
  };
  await refreshProtection();
  const scopedIds = new Set(sessions.map((session) => sanitizeTurnSnapshotComponent(session.sessionId)));
  const eligible = new Set([...objects.keys()].filter((id) => !protectedIds.has(id.split("/")[3]!)
    && (!protectedSessions || scopedIds.has(id.split("/")[3]!))));
  const retained = new Set<string>();
  for (const session of sessions) {
    for (const entry of [...session.checkpoints, ...(session.backups ?? [])]) {
      if (entry.sessionId !== session.sessionId) continue;
      try {
        const before = turnSnapshotRef(session.sessionId, entry.turnId, "before");
        const after = turnSnapshotRef(session.sessionId, entry.turnId, "after");
        if (!eligible.has(before) || !eligible.has(after)) continue;
        // One Git inventory supplies tree types for the whole session. Legacy
        // runners may return names alone; validate those pairs individually.
        if (!listedTreePair(objects, before, after) && !await adapter.pair(before, after, true)) continue;
        retained.add(before);
        retained.add(after);
      } catch { /* Invalid entries cannot retain storage. */ }
    }
    for (const transaction of session.restoreTransactions ?? []) {
      if (transaction.sessionId !== session.sessionId || transaction.state === "committed" || transaction.state === "recovered") continue;
      try {
        for (const phase of ["before", "after"] as const) {
          const id = turnSnapshotRef(transaction.backupSessionId, transaction.backupTurnId, phase);
          // Recovery must retain a surviving half of an interrupted backup.
          if (eligible.has(id)) retained.add(id);
        }
      } catch { /* Malformed transaction metadata cannot retain storage. */ }
    }
  }
  await refreshProtection();
  const doomed = [...eligible].filter((id) => !retained.has(id) && !protectedIds.has(id.split("/")[3]!));
  const recent = await adapter.recent(doomed, options);
  await Promise.all(doomed.filter((id) => !recent.has(id)).map((id) => adapter.remove(id)));
  await adapter.gc();
}

/** Session-open recovery removes unpublished checkpoints while retaining complete durable pairs and backups. */
export async function cleanupOrphanTurnCheckpointRefs(
  cwd: string, sessionId: string, checkpoints: readonly StoredTurnCheckpoint[], runGit: GitRunner = git,
  backups: readonly TurnRestoreBackup[] = [], options: CheckpointRefSweepOptions = {},
): Promise<void> {
  const prefix = `refs/tau/checkpoints/${sanitizeTurnSnapshotComponent(sessionId)}/`;
  for (const adapter of [gitSnapshotAdapter(cwd, runGit), filesystemSnapshotAdapter(cwd)]) {
    await sweepAdapter(adapter, prefix, [{ sessionId, checkpoints, backups }], options);
  }
}

/**
 * The caller holds this checkout's lease and supplies persisted and live
 * sessions. Linked worktrees share Git refs but have independent leases, so
 * repeated observations protect sibling writers throughout enumeration.
 */
export async function cleanupCheckpointRefsForLiveSessions(
  cwd: string, sessions: readonly LiveCheckpointSession[], runGit: GitRunner = git, options: CheckpointRefSweepOptions = {},
): Promise<void> {
  const canonicalCwd = await realpath(cwd).catch(() => resolve(cwd));
  const scoped = await Promise.all(sessions.map(async (session) => {
    try { sanitizeTurnSnapshotComponent(session.sessionId); } catch { return undefined; }
    if (!session.cwd) return session;
    const sessionCwd = await realpath(session.cwd).catch(() => resolve(session.cwd!));
    return sessionCwd === canonicalCwd ? session : undefined;
  })).then((items) => items.filter((item): item is LiveCheckpointSession => Boolean(item)));
  const protectedSessions = async () => new Set((await listLiveWorkspaceLeaseSessions()).flatMap((owner) => {
    try { return [sanitizeTurnSnapshotComponent(owner.sessionId)]; } catch { return []; }
  }));
  for (const adapter of [gitSnapshotAdapter(cwd, runGit), filesystemSnapshotAdapter(cwd)]) {
    await sweepAdapter(adapter, "refs/tau/checkpoints/", scoped, options, protectedSessions);
  }
}

/** Summaries never load patches. Complete file lists remain a lazy storage read. */
export async function diffWorkspaceSnapshots(cwd: string, before: string, after: string, options: SnapshotDiffOptions = {}): Promise<UiWorkspaceChanges> {
  if (!isTurnSnapshotId(before) || !isTurnSnapshotId(after)) throw new Error("Invalid turn checkpoint snapshot ID.");
  if (!snapshotPairShape(before, after)) throw new Error("Turn checkpoint snapshot refs must be an ordered before/after pair in one namespace.");
  if (options.expected) assertExpectedPair(before, after, options.expected);
  const { pair } = await snapshotPair(cwd, before, after, options.runGit ?? git, Boolean(options.expected));
  return pair.diff(options.branch);
}

/** Compare a verified restore target to a temporary capture of the live tree, then discard that capture. */
export async function previewWorkspaceRestore(
  cwd: string, before: string, after: string, expected: SnapshotRefExpectation,
  options: { branch?: string; runGit?: GitRunner } = {},
): Promise<UiWorkspaceChanges> {
  assertExpectedPair(before, after, expected);
  const runGit = options.runGit ?? git;
  const target = await snapshotPair(cwd, before, after, runGit, true);
  await target.pair.assertRestorable("Selected checkpoint");
  const previewTurnId = `restore-preview-${randomUUID()}`;
  const current = await createWorkspaceSnapshot(cwd, {
    namespace: `${sanitizeTurnSnapshotComponent(expected.sessionId)}/${sanitizeTurnSnapshotComponent(previewTurnId)}`,
    phase: "after",
  });
  try {
    if (current.backend !== target.adapter.kind) throw new Error("The checkpoint and live workspace use different snapshot backends.");
    const comparison = await target.adapter.pair(after, current.id, false);
    if (!comparison) throw new Error("The live workspace snapshot could not be verified.");
    return comparison.diff(options.branch);
  } finally {
    await deleteWorkspaceSnapshot(cwd, current.id, { ...expected, turnId: previewTurnId, phase: "after", treeId: current.treeId }, runGit).catch(() => undefined);
  }
}

const MAX_SNAPSHOT_FILE_PAGE = 40;

function snapshotCursor(cursor: string | undefined, total: number): number {
  if (cursor === undefined) return 0;
  if (!/^\d+$/u.test(cursor)) throw new Error("Invalid turn file cursor.");
  const offset = Number(cursor);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > total) throw new Error("Invalid turn file cursor.");
  return offset;
}

/** Loads a bounded file-list page from Git; no complete list crosses the API seam. */
export async function diffWorkspaceSnapshotPage(
  cwd: string,
  beforeSnapshotId: string,
  afterSnapshotId: string,
  options: SnapshotPageOptions,
): Promise<UiWorkspaceChangesPage> {
  const runGit = options.runGit ?? git;
  const full = await diffWorkspaceSnapshots(cwd, beforeSnapshotId, afterSnapshotId, {
    branch: options.branch,
    runGit,
    expected: { sessionId: options.sessionId, turnId: options.turnId },
  });
  const changes = options.attribute ? await options.attribute(full) : full;
  const offset = snapshotCursor(options.cursor, changes.files.length);
  const requestedLimit = Number.isFinite(options.limit) ? Math.floor(options.limit as number) : MAX_SNAPSHOT_FILE_PAGE;
  const limit = Math.min(MAX_SNAPSHOT_FILE_PAGE, Math.max(1, requestedLimit));
  const files = changes.files.slice(offset, offset + limit).map((file) => ({ ...file }));
  const nextCursor = offset + files.length < changes.files.length ? String(offset + files.length) : undefined;
  return {
    branch: changes.branch,
    files,
    fileCount: changes.files.length,
    ...(changes.completeness ? { completeness: changes.completeness } : {}),
    ...(changes.incompleteReason ? { incompleteReason: changes.incompleteReason } : {}),
    ...(changes.omittedFileCount !== undefined ? { omittedFileCount: changes.omittedFileCount } : {}),
    added: changes.added,
    removed: changes.removed,
    proposedMessage: changes.proposedMessage,
    ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
    ...(nextCursor ? { nextCursor } : {}),
    hasMore: Boolean(nextCursor),
  };
}

/** Historical file reads are bounded and return an explanatory empty diff when unavailable. */
export async function getSnapshotFileDiff(
  cwd: string, before: string, after: string, path: string, options: DiffLoadOptions = {}, expected?: SnapshotRefExpectation,
): Promise<UiFileDiff> {
  const empty = (note: string): UiFileDiff => ({ path, added: 0, removed: 0, hunks: [], note });
  if (!isTurnSnapshotId(before) || !isTurnSnapshotId(after) || !snapshotPairShape(before, after)) {
    return empty("This turn checkpoint is no longer available.");
  }
  try {
    await assertWorkspacePath(cwd, path);
    if (expected) assertExpectedPair(before, after, expected);
    const { pair } = await snapshotPair(cwd, before, after, git, Boolean(expected));
    return await pair.fileDiff(path, options);
  } catch {
    return empty("Could not read this historical diff.");
  }
}
