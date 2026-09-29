import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { realpath, rm, stat, utimes } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type DiffLoadOptions,
  type HostActionResult,
  type HostActivationTransaction,
  type HostExtensionServices,
  type HostSessionFile,
  type HostSessionSummary,
  type HostSessionSweep,
  type HostThread,
  type HostThreadLifecycle,
  type HostTurnObserver,
  type RuntimeExtensionFactory,
  type UiFileDiff,
  type UiWorkspaceChanges,
  type UiWorkspaceChangesPage,
} from "tau/host-extension";
import * as workspaceGit from "./workspace-git.js";
import { assistantAnchorForMessage } from "./pi-turn-checkpoint-extension.js";
import {
  checkpointsForBranch,
  cloneTurnCheckpoint,
  turnCheckpointsFromEntries,
  turnRestoreBackupsFromEntries,
  turnRestoreTransactionsFromEntries,
  turnSnapshotRef,
  TURN_CHECKPOINT_CUSTOM_TYPE,
  TURN_RESTORE_BACKUP_CUSTOM_TYPE,
  TURN_RESTORE_TRANSACTION_CUSTOM_TYPE,
} from "./turn-checkpoint-codec.js";
import { readHeadReflog, type ReflogEntry } from "./turn-attribution.js";
import {
  createWorkspaceKitCheckpointFeature,
  createWorkspaceKitCheckpointMaintenance,
  reviseLegacyCheckpoint,
  type WorkspaceKitCheckpointFeature,
  type WorkspaceKitCheckpointMaintenance,
  type WorkspaceKitLiveCheckpointSession,
} from "./workspace-kit-checkpoints.js";
import { WorkspaceCheckpointLeaseManager } from "./workspace-checkpoint-lease.js";
import type { StoredTurnCheckpoint, TurnRestoreTransaction } from "./turn-checkpoint-types.js";
import { WORKSPACE_HOST_EXTENSION_ID, type CheckpointEvent, type WorkspaceCheckpointList } from "./protocol.js";

export interface WorkspaceKitLifecycleOptions {
  leaseManager?: WorkspaceCheckpointLeaseManager;
  maintenance?: WorkspaceKitCheckpointMaintenance;
  /** Checkpoint events for the desktop half. */
  emit(event: CheckpointEvent): void;
  /** The kit's Git cache, staled after a workspace was rewritten. */
  git?: { invalidate(cwd: string): void };
  /** Last known branch of a workspace, presentation metadata only. */
  branch?(cwd: string): string | undefined;
  /** Whether a checkpoint's snapshot refs still exist in the workspace; Git by default. */
  hasSnapshotRefs?(cwd: string, checkpoint: StoredTurnCheckpoint): Promise<boolean>;
  /** An old record read again after a branch change inside its turn. */
  revised?(sessionId: string, checkpoint: StoredTurnCheckpoint): void;
}

/** The checkpoint side of Workspace Kit's host entry: capture, restore, recovery and ref upkeep. */
export interface WorkspaceKitLifecycle {
  readonly lifecycle: HostThreadLifecycle;
  readonly turns: HostTurnObserver;
  readonly runtimeExtension: RuntimeExtensionFactory;
  /** Entries checkpoint cards anchor to. */
  pinnedEntries(thread: HostThread): string[];
  checkpoints(sessionId: string): Promise<WorkspaceCheckpointList>;
  canRestore(sessionId: string, checkpointId: string): Promise<boolean>;
  restorePreview(sessionId: string, checkpointId: string): Promise<UiWorkspaceChanges>;
  restore(sessionId: string, checkpointId: string): Promise<HostActionResult>;
  /** Back to a checkpoint in the conversation only; the files stay as they are. */
  rewind(sessionId: string, checkpointId: string): Promise<HostActionResult>;
  turnFileDiff(sessionId: string, checkpointId: string, path: string, options?: DiffLoadOptions): Promise<UiFileDiff>;
  turnFiles(sessionId: string, checkpointId: string, cursor?: string, limit?: number): Promise<UiWorkspaceChangesPage>;
}

/**
 * A committed restore keeps its recovery thread discoverable without making
 * that thread the one resumed by `continueRecent` on the next launch.
 */
export async function prioritizeRestoreTargetSession(targetPath: string, backupPath: string): Promise<void> {
  const [target, backup] = await Promise.all([stat(targetPath), stat(backupPath)]);
  // Keep a visible gap because findMostRecentSession compares millisecond
  // timestamps while some filesystems expose coarser mtime resolution.
  const targetTime = Math.max(Date.now() + 2_000, target.mtimeMs + 1_000, backup.mtimeMs + 2_000);
  const backupTime = Math.max(0, targetTime - 1_000);
  await utimes(backupPath, new Date(backupTime), new Date(backupTime));
  await utimes(targetPath, new Date(targetTime), new Date(targetTime));
}

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

interface SessionFeature {
  feature: WorkspaceKitCheckpointFeature;
  cwd: string;
  /** Whether each accepted turn queued behind a running one. */
  deferred: Map<string, boolean>;
}

export function createWorkspaceKitLifecycle(services: HostExtensionServices, options: WorkspaceKitLifecycleOptions): WorkspaceKitLifecycle {
  const leaseManager = options.leaseManager ?? new WorkspaceCheckpointLeaseManager();
  const maintenance = options.maintenance ?? createWorkspaceKitCheckpointMaintenance(leaseManager, {
    onSkipped: (cwd) => services.log("turn.checkpoint.maintenance-skipped", `${cwd}: workspace busy`),
  });
  const features = new Map<string, SessionFeature>();
  const git = options.git ?? { invalidate: () => undefined };
  const branchOf = (cwd: string) => options.branch?.(cwd);
  /** A restore of this workspace is in progress; its own activation must not replay its journal. */
  let restoringCwd: string | undefined;

  const emit = (event: CheckpointEvent) => {
    try { options.emit(event); } catch { /* UI delivery is best effort */ }
  };

  const featureFor = (sessionId: string, cwd: string): SessionFeature => {
    const existing = features.get(sessionId);
    if (existing) return existing;
    const record: SessionFeature = {
      cwd,
      deferred: new Map(),
      feature: createWorkspaceKitCheckpointFeature({
        contextForTurn: () => ({ cwd, sessionId }),
        branchForWorkspace: (workspace) => branchOf(workspace),
        leaseManager,
        maintenance,
        appendCheckpoint: async (stored) => {
          const thread = services.thread(sessionId);
          if (!thread || !thread.isCurrent()) throw new Error("The thread closed before its checkpoint was written.");
          if (turnCheckpointsFromEntries(thread.entries(), sessionId).some((entry) => entry.id === stored.id)) return;
          // The lease is held until the entry is appended; a write error
          // propagates so the lifecycle removes the provisional refs instead
          // of releasing a checkpoint that only exists in memory.
          thread.appendEntry(TURN_CHECKPOINT_CUSTOM_TYPE, stored);
          emit({ type: "turn-checkpoint", sessionId, checkpoint: cloneTurnCheckpoint(stored) });
          try { services.log("turn.checkpoint.saved", `${stored.fileCount} ${stored.fileCount === 1 ? "file" : "files"}`); } catch { /* diagnostics are best effort */ }
        },
        onError: (error, capture) => services.log("turn.checkpoint.failed", `${capture.id}: ${errorMessage(error)}`),
        onStatus: (status, capture) => {
          if (status === "skipped") services.log("turn.checkpoint.skipped", `${capture.id}: workspace busy`);
          emit({ type: "turn-checkpoint-status", sessionId, turnId: capture.id, status });
        },
        onReleased: (capture) => {
          record.deferred.delete(capture.id);
          // The capture counts as pending work until here, and pending work is
          // what makes `canRestore` say no. Tell the cards it is over.
          emit({ type: "turn-checkpoint-status", sessionId, turnId: capture.id, status: "released" });
        },
      }),
    };
    features.set(sessionId, record);
    return record;
  };

  const checkpointsOf = (entries: readonly unknown[], sessionId: string) => turnCheckpointsFromEntries(entries, sessionId);

  /** What one session's journal claims of a workspace's snapshot refs. */
  const claimOf = (sessionId: string, cwd: string, entries: readonly unknown[]): WorkspaceKitLiveCheckpointSession => ({
    sessionId,
    cwd: cwd || services.cwd(),
    checkpoints: checkpointsOf(entries, sessionId),
    backups: turnRestoreBackupsFromEntries(entries, sessionId),
    restoreTransactions: turnRestoreTransactionsFromEntries(entries, sessionId),
  });

  /**
   * A live thread's journal is ahead of its session file between the append and
   * the flush, so a ref is orphaned only when neither claims it. The live side
   * wins on a shared id; it is the newer of the two by construction.
   */
  const mergeClaims = (
    persisted: WorkspaceKitLiveCheckpointSession,
    live: WorkspaceKitLiveCheckpointSession,
  ): WorkspaceKitLiveCheckpointSession => {
    const checkpoints = new Map(persisted.checkpoints.map((checkpoint) => [checkpoint.id, checkpoint] as const));
    for (const checkpoint of live.checkpoints) checkpoints.set(checkpoint.id, checkpoint);
    const backups = new Map((persisted.backups ?? []).map((backup) => [backup.backupId, backup] as const));
    for (const backup of live.backups ?? []) backups.set(backup.backupId, backup);
    const transactions = new Map((persisted.restoreTransactions ?? []).map((entry) => [entry.transactionId, entry] as const));
    for (const entry of live.restoreTransactions ?? []) transactions.set(entry.transactionId, entry);
    return {
      sessionId: persisted.sessionId,
      cwd: persisted.cwd || live.cwd,
      checkpoints: [...checkpoints.values()],
      backups: [...backups.values()],
      restoreTransactions: [...transactions.values()],
    };
  };

  /**
   * Claims of session files as last read, keyed by path and stamped with the
   * file's mtime and size: every activation scans all sessions, and a file
   * that has not changed says the same as before.
   */
  const persistedClaims = new Map<string, { stamp: string; claim: WorkspaceKitLiveCheckpointSession }>();
  const fileStamp = (path: string): string | undefined => {
    try {
      const info = statSync(path);
      return `${info.mtimeMs}:${info.size}`;
    } catch {
      return undefined;
    }
  };

  const sessionCheckpoints = (session: HostSessionSummary): WorkspaceKitLiveCheckpointSession | undefined => {
    const stamp = fileStamp(session.path);
    const cached = stamp === undefined ? undefined : persistedClaims.get(session.path);
    if (cached && cached.stamp === stamp && cached.claim.sessionId === session.sessionId) return cached.claim;
    try {
      const claim = claimOf(session.sessionId, session.cwd, services.sessions.open(session.path).entries());
      if (stamp === undefined) persistedClaims.delete(session.path);
      else persistedClaims.set(session.path, { stamp, claim });
      return claim;
    } catch {
      // A session can disappear between listing and opening; its refs are
      // intentionally eligible for the same sweep.
      persistedClaims.delete(session.path);
      return undefined;
    }
  };

  /**
   * Finish restore transactions left behind by a process crash. The backup
   * thread is the journal owner, so a prepared or workspace-applied marker is
   * sufficient to identify the only safe recovery target without trusting the
   * partially-created target runtime.
   */
  const recoverPendingRestoreTransactions = async (workspaceCwd: string): Promise<void> => {
    if (services.attachedRuntime()) return;
    const sessions = await services.sessions.list();
    const byId = new Map(sessions.map((session) => [session.sessionId, session] as const));
    const currentWorkspace = await realpath(workspaceCwd).catch(() => resolve(workspaceCwd));
    const listed = new Set(sessions.map((session) => session.path));
    for (const path of persistedClaims.keys()) if (!listed.has(path)) persistedClaims.delete(path);
    for (const session of sessions) {
      const all = sessionCheckpoints(session)?.restoreTransactions ?? [];
      if (all.length === 0) continue;
      const pending = all.filter((transaction) => transaction.state !== "committed" && transaction.state !== "recovered");
      const committed = all.filter((transaction) => transaction.state === "committed" && transaction.kind === "checkpoint-restore");
      for (const transaction of committed) {
        const target = byId.get(transaction.targetSessionId);
        if (!target?.path || target.path === session.path) continue;
        const transactionWorkspace = await realpath(transaction.cwd).catch(() => resolve(transaction.cwd));
        if (transactionWorkspace !== currentWorkspace) continue;
        const [targetStat, backupStat] = await Promise.all([
          stat(target.path).catch(() => undefined),
          stat(session.path).catch(() => undefined),
        ]);
        // A crash can occur after the committed marker updates the backup's
        // mtime but before the target-prioritization write. Repair that
        // discoverability gap before continueRecent chooses a session.
        if (targetStat && backupStat && backupStat.mtimeMs >= targetStat.mtimeMs) {
          await prioritizeRestoreTargetSession(target.path, session.path).catch(() => undefined);
        }
      }
      for (const transaction of pending) {
        // The list spans every project. Recovery is deliberately scoped to the
        // checkout being opened; mutating an unrelated project's workspace
        // during startup would be a data-loss bug in its own right.
        const transactionWorkspace = await realpath(transaction.cwd).catch(() => resolve(transaction.cwd));
        if (transactionWorkspace !== currentWorkspace) continue;
        let file: HostSessionFile;
        try { file = services.sessions.open(session.path); } catch { break; }
        await recoverRestoreTransaction(transaction, file, byId);
      }
    }
  };

  const recoverRestoreTransaction = async (
    transaction: TurnRestoreTransaction,
    backup: HostSessionFile,
    sessions: ReadonlyMap<string, HostSessionSummary>,
  ): Promise<void> => {
    const [transactionWorkspace, backupWorkspace] = await Promise.all([
      leaseManager.canonicalKey(transaction.cwd),
      leaseManager.canonicalKey(backup.cwd),
    ]);
    if (transactionWorkspace !== backupWorkspace) {
      throw new Error(`Restore recovery refused a workspace mismatch for backup ${transaction.backupSessionId.slice(0, 12)}.`);
    }
    const lease = await leaseManager.acquire(transaction.cwd, {
      sessionId: transaction.backupSessionId,
      turnId: `restore-recovery-${transaction.transactionId}`,
    });
    try {
      if (transaction.kind === "backup-open") {
        // Opening a backup uses the durable backup pair as the target and a
        // temporary pair in the same backup session as the rollback. If the
        // process died before activation committed, put the pre-open
        // workspace back and leave the backup thread unopened.
        await workspaceGit.restoreWorkspaceSnapshot(transaction.cwd, transaction.backupAfterSnapshotId, {
          target: { sessionId: transaction.backupSessionId, turnId: transaction.backupTurnId },
          rollback: { sessionId: transaction.sourceSessionId, turnId: transaction.sourceTurnId },
        });
        git.invalidate(transaction.cwd);
        backup.appendEntry(TURN_RESTORE_TRANSACTION_CUSTOM_TYPE, { ...transaction, state: "recovered" });
        const previousPath = transaction.previousSessionId ? sessions.get(transaction.previousSessionId)?.path : undefined;
        if (previousPath && previousPath !== backup.path) {
          await prioritizeRestoreTargetSession(previousPath, backup.path).catch(() => undefined);
        } else {
          await utimes(backup.path, new Date(0), new Date(0)).catch(() => undefined);
        }
        // Recovery is durable before deleting the temporary rollback pair. If
        // cleanup is interrupted, the committed recovery marker makes the
        // harmless orphan eligible for ordinary checkpoint GC.
        await workspaceGit.cleanupTurnCheckpointRefs(transaction.cwd, [{
          sessionId: transaction.backupSessionId,
          turnId: transaction.backupTurnId,
        }]);
        return;
      }
      const backupAfter = turnSnapshotRef(transaction.backupSessionId, transaction.backupTurnId, "after");
      // Replaying the backup pair is idempotent and also repairs a process
      // death in the middle of Git's clean/read-tree sequence. Using the same
      // pair as rollback means an apply failure is retried against the same
      // known-good state rather than falling back to the selected checkpoint.
      await workspaceGit.restoreWorkspaceSnapshot(transaction.cwd, backupAfter, {
        target: { sessionId: transaction.backupSessionId, turnId: transaction.backupTurnId },
        rollback: { sessionId: transaction.backupSessionId, turnId: transaction.backupTurnId },
      });
      git.invalidate(transaction.cwd);
      // Remove the uncommitted target before recording recovery. If the
      // process dies between these operations the next startup simply repeats
      // the idempotent workspace replay and cleanup.
      await workspaceGit.cleanupTurnCheckpointSessionRefs(transaction.cwd, transaction.targetSessionId);
      const target = sessions.get(transaction.targetSessionId);
      if (target?.path && target.path !== backup.path) await rm(target.path, { force: true });
      backup.appendEntry(TURN_RESTORE_TRANSACTION_CUSTOM_TYPE, { ...transaction, state: "recovered" });
    } catch (error) {
      throw new Error(`Restore recovery failed for backup ${transaction.backupSessionId.slice(0, 12)}; the workspace was not exposed as restored. ${errorMessage(error)}`, { cause: error });
    } finally {
      await lease.release();
    }
  };

  /**
   * A restore backup is a real recovery thread, not only a retention marker.
   * Opening it replays its verified workspace pair while retaining a temporary
   * rollback pair for the workspace that is currently on disk.
   */
  const restoreBackupWorkspaceOnOpen = async (thread: HostThread): Promise<HostActivationTransaction | undefined> => {
    // Recovery is workspace-scoped, not backend-scoped. A normal project
    // session can be the first thread opened after switching projects and
    // still needs to repair a pending clean/read-tree transaction in its cwd.
    if (restoringCwd !== thread.cwd) await recoverPendingRestoreTransactions(thread.cwd);
    if (thread.backendKind !== "pi") return undefined;
    const backup = turnRestoreBackupsFromEntries(thread.entries(), thread.sessionId).at(-1);
    if (!backup) return undefined;
    if (backup.cwd !== thread.cwd) throw new Error("This restore backup belongs to another workspace.");
    if (!thread.isIdle()) throw new Error("Wait for the backup thread to become idle before restoring its workspace.");
    const active = services.thread();
    if (active && active.sessionId !== thread.sessionId && active.isStreaming()) {
      throw new Error("Wait for the active turn to finish before opening the restore backup.");
    }
    await workspaceGit.validateRestorableWorkspaceSnapshotRefs(
      thread.cwd,
      backup.beforeSnapshotId,
      backup.afterSnapshotId,
      { sessionId: backup.sessionId, turnId: backup.turnId },
    );
    const rollbackTurnId = `open-backup-${randomUUID()}`;
    const lease = await leaseManager.acquire(thread.cwd, { sessionId: thread.sessionId, turnId: rollbackTurnId });
    let rollbackBefore: workspaceGit.WorkspaceSnapshot | undefined;
    let rollbackAfter: workspaceGit.WorkspaceSnapshot | undefined;
    let handedOff = false;
    let transaction: TurnRestoreTransaction | undefined;
    const cleanupRollback = async (): Promise<void> => {
      if (!rollbackBefore && !rollbackAfter) return;
      await workspaceGit.cleanupTurnCheckpointRefs(thread.cwd, [{ sessionId: thread.sessionId, turnId: rollbackTurnId }]);
    };
    const appendTransaction = (state: TurnRestoreTransaction["state"]): void => {
      if (!transaction) return;
      transaction = { ...transaction, state };
      thread.appendEntry(TURN_RESTORE_TRANSACTION_CUSTOM_TYPE, transaction);
    };
    const phaseState = (phase: string): TurnRestoreTransaction["state"] => phase === "apply-started"
      ? "applying"
      : phase === "cleaned"
        ? "cleaned"
        : phase === "applied"
          ? "workspace-applied"
          : "rolling-back";
    try {
      rollbackBefore = await workspaceGit.createTurnWorkspaceSnapshot(thread.cwd, thread.sessionId, rollbackTurnId, "before");
      rollbackAfter = await workspaceGit.createTurnWorkspaceSnapshot(thread.cwd, thread.sessionId, rollbackTurnId, "after");
      transaction = {
        version: 1,
        kind: "backup-open",
        transactionId: randomUUID(),
        state: "prepared",
        sessionId: thread.sessionId,
        backupSessionId: thread.sessionId,
        backupTurnId: rollbackTurnId,
        sourceSessionId: backup.sessionId,
        sourceTurnId: backup.turnId,
        sourceCheckpointId: backup.backupId,
        targetSessionId: thread.sessionId,
        ...(active && active.sessionId !== thread.sessionId ? { previousSessionId: active.sessionId } : {}),
        cwd: thread.cwd,
        targetAfterSnapshotId: backup.afterSnapshotId,
        backupAfterSnapshotId: rollbackAfter.id,
        createdAt: Date.now(),
      };
      appendTransaction("prepared");
      await workspaceGit.restoreWorkspaceSnapshot(thread.cwd, backup.afterSnapshotId, {
        target: { sessionId: backup.sessionId, turnId: backup.turnId },
        rollback: { sessionId: thread.sessionId, turnId: rollbackTurnId },
        onPhase: (phase) => appendTransaction(phaseState(phase)),
      });
      git.invalidate(thread.cwd);
      appendTransaction("workspace-applied");
      handedOff = true;
      let finished = false;
      const commit = async (): Promise<void> => {
        if (finished) return;
        appendTransaction("committed");
        finished = true;
        await cleanupRollback().catch(() => undefined);
        await lease.release();
      };
      const rollback = async (): Promise<void> => {
        if (finished) return;
        try {
          await workspaceGit.restoreWorkspaceSnapshot(thread.cwd, rollbackAfter!.id, {
            target: { sessionId: thread.sessionId, turnId: rollbackTurnId },
            rollback: { sessionId: backup.sessionId, turnId: backup.turnId },
          });
          git.invalidate(thread.cwd);
          appendTransaction("recovered");
          finished = true;
          await cleanupRollback().catch(() => undefined);
        } finally {
          await lease.release();
        }
      };
      return { commit, rollback };
    } catch (error) {
      let recovered = false;
      const recoveryErrors: unknown[] = [];
      if (transaction && rollbackAfter) {
        try {
          await workspaceGit.restoreWorkspaceSnapshot(thread.cwd, rollbackAfter.id, {
            target: { sessionId: thread.sessionId, turnId: rollbackTurnId },
            rollback: { sessionId: backup.sessionId, turnId: backup.turnId },
          });
          git.invalidate(thread.cwd);
          appendTransaction("recovered");
          recovered = true;
        } catch (recoveryError) {
          recoveryErrors.push(recoveryError);
        }
      }
      if (recovered) await cleanupRollback().catch((cleanupError) => recoveryErrors.push(cleanupError));
      const message = `The restore backup could not be applied safely; the selected thread was not opened. ${errorMessage(error)}`;
      if (recoveryErrors.length > 0) throw new AggregateError([error, ...recoveryErrors], `${message} Workspace recovery needs attention.`, { cause: error });
      throw new Error(message, { cause: error });
    } finally {
      // The lease stays held while the host publishes the selected thread;
      // commit or rollback releases it.
      if (!handedOff) await lease.release();
    }
  };

  /** What both ways back to a checkpoint need: an idle local Pi thread whose saved branch still has the checkpoint's answer. */
  const verifiedAnchor = (sessionId: string, checkpointId: string) => {
    if (services.attachedRuntime()) throw new Error("Restore is unavailable while Pi owns this thread.");
    const source = services.thread();
    if (!source) throw new Error("Pi runtime is not ready");
    if (source.sessionId !== sessionId) throw new Error("The selected thread changed before it could be restored.");
    if (source.backendKind !== "pi") throw new Error("Only local Pi threads with workspace checkpoints can be restored.");
    if (!source.isIdle() || (features.get(sessionId)?.feature.runtime.pendingCount ?? 0) > 0) {
      throw new Error("Wait for the active turn and its checkpoint to finish before restoring it.");
    }
    const sourceFile = source.sessionFile;
    if (!sourceFile || !existsSync(sourceFile)) throw new Error("This thread has no durable session to restore.");
    const sourceBranch = services.sessions.open(sourceFile).entries();
    const sourceCheckpoints = checkpointsOf(sourceBranch, sessionId);
    const checkpoint = sourceCheckpoints.find((entry) => entry.id === checkpointId);
    if (!checkpoint) throw new Error("This turn checkpoint is no longer available.");
    const anchor = sourceBranch.find((entry) => {
      if (!entry || typeof entry !== "object") return false;
      const item = entry as { id?: unknown; type?: unknown; message?: unknown };
      return item.id === checkpoint.anchorMessageId
        && item.type === "message"
        && Boolean(item.message && typeof item.message === "object" && (item.message as { role?: unknown }).role === "assistant");
    });
    if (!anchor || typeof (anchor as { id?: unknown }).id !== "string") {
      throw new Error("This checkpoint has no completed assistant anchor and cannot be restored.");
    }
    return { source, sourceFile, sourceCheckpoints, checkpoint };
  };

  /** Shared trust boundary used by both the restore action and its UI offer. */
  const verifiedRestoreCheckpoint = async (sessionId: string, checkpointId: string) => {
    const { source, sourceFile, sourceCheckpoints, checkpoint } = verifiedAnchor(sessionId, checkpointId);
    if (checkpoint.completeness === "partial") {
      throw new Error("This checkpoint is incomplete and cannot be restored safely. Use Fork instead.");
    }
    await workspaceGit.validateRestorableWorkspaceSnapshotRefs(
      source.cwd,
      checkpoint.beforeSnapshotId,
      checkpoint.afterSnapshotId,
      { sessionId: source.sessionId, turnId: checkpoint.turnId },
    );
    return { source, sourceFile, sourceCheckpoints, checkpoint };
  };

  /**
   * Restores a completed local Pi turn through a new active branch. The source
   * session is never truncated: a separately named backup preserves its
   * current branch and workspace snapshot before the target workspace is
   * changed. Fork therefore remains the non-destructive explicit alternative.
   */
  const restore = async (sessionId: string, checkpointId: string): Promise<HostActionResult> => {
    if (services.attachedRuntime()) {
      throw new Error("Restore is unavailable while Pi owns this thread. Use Fork to keep the current workspace unchanged.");
    }
    return services.sessions.exclusive(async () => {
      await recoverPendingRestoreTransactions(services.cwd());
      const { source, sourceFile, sourceCheckpoints, checkpoint } = await verifiedRestoreCheckpoint(sessionId, checkpointId);
      const cwd = source.cwd;

      // Build and open the candidate target before taking the destructive
      // workspace step. It is not adopted until the workspace transaction has
      // succeeded, so a runtime-construction failure leaves the source active.
      const target = services.sessions.open(sourceFile).branch(checkpoint.anchorMessageId);
      if (!target) throw new Error("Failed to create the restored thread.");
      const targetPath = target.path;
      const targetThreadId = target.sessionId;
      let prepared: Awaited<ReturnType<typeof services.sessions.prepare>> | undefined;
      let backupPath: string | undefined;
      let backupSessionId: string | undefined;
      let backupTurnId: string | undefined;
      let backup: HostSessionFile | undefined;
      let restoreTransaction: TurnRestoreTransaction | undefined;
      let backupDurable = false;
      let restoreAttempted = false;
      let restoreCommitted = false;
      const startedAt = performance.now();
      let lease: Awaited<ReturnType<WorkspaceCheckpointLeaseManager["acquire"]>> | undefined;
      let activated: HostActionResult | undefined;
      const cleanupTarget = async (): Promise<void> => {
        if (prepared) {
          await prepared.discard().catch(() => undefined);
          prepared = undefined;
        }
        await workspaceGit.cleanupTurnCheckpointSessionRefs(cwd, targetThreadId).catch(() => undefined);
        await rm(targetPath, { force: true }).catch(() => undefined);
      };
      const cleanupUncommittedBackup = async (): Promise<void> => {
        if (!backupSessionId || backupDurable) return;
        await workspaceGit.cleanupTurnCheckpointSessionRefs(cwd, backupSessionId).catch(() => undefined);
        if (backupPath) await rm(backupPath, { force: true }).catch(() => undefined);
      };
      const journal = (state: TurnRestoreTransaction["state"]): void => {
        if (!restoreTransaction || !backup) return;
        restoreTransaction = { ...restoreTransaction, state };
        backup.appendEntry(TURN_RESTORE_TRANSACTION_CUSTOM_TYPE, restoreTransaction);
      };

      restoringCwd = cwd;
      try {
        prepared = await services.sessions.prepare(target, { previousSessionFile: sourceFile });
        lease = await leaseManager.acquire(cwd, { sessionId: source.sessionId, turnId: `restore-${randomUUID()}` });

        // Create the backup from the source branch's current leaf. This is the
        // first durable artifact and is complete before any workspace restore.
        const backupSource = services.sessions.open(sourceFile);
        const sourceLeaf = backupSource.leafId();
        if (!sourceLeaf) throw new Error("This thread has no current conversation branch to back up.");
        const durableBackup = backupSource.branch(sourceLeaf);
        if (!durableBackup) throw new Error("Failed to create the restore backup thread.");
        backupPath = durableBackup.path;
        backup = durableBackup;
        backupSessionId = durableBackup.sessionId;
        backupTurnId = `restore-backup-${randomUUID()}`;
        await maintenance.rehomeFork({
          cwd,
          sourceSessionId: source.sessionId,
          targetSessionId: backupSessionId,
          checkpoints: sourceCheckpoints,
          lease,
          appendEntry: (customType, data) => { durableBackup.appendEntry(customType, data); },
          committedCheckpoints: () => checkpointsOf(durableBackup.entries(), backupSessionId!),
        });
        const backupBefore = await workspaceGit.createTurnWorkspaceSnapshot(cwd, backupSessionId, backupTurnId, "before");
        const backupAfter = await workspaceGit.createTurnWorkspaceSnapshot(cwd, backupSessionId, backupTurnId, "after");
        if (backupBefore.complete === false || backupAfter.complete === false) {
          throw new Error("The current workspace is only partially captured, so Tau cannot create a recoverable restore backup.");
        }
        await backup.appendInfo(`Backup before restore to turn ${checkpoint.turnId.slice(0, 12)}`);
        backup.appendEntry(TURN_RESTORE_BACKUP_CUSTOM_TYPE, {
          version: 1,
          backupId: randomUUID(),
          sessionId: backupSessionId,
          turnId: backupTurnId,
          sourceSessionId: source.sessionId,
          sourceCheckpointId: checkpoint.id,
          cwd,
          beforeSnapshotId: backupBefore.id,
          afterSnapshotId: backupAfter.id,
          createdAt: Date.now(),
        });
        backupDurable = true;

        const targetCheckpoints = checkpointsForBranch(target.entries(), sourceCheckpoints);
        await maintenance.rehomeFork({
          cwd,
          sourceSessionId: source.sessionId,
          targetSessionId: targetThreadId,
          checkpoints: targetCheckpoints,
          lease,
          appendEntry: (customType, data) => { target.appendEntry(customType, data); },
          committedCheckpoints: () => checkpointsOf(target.entries(), targetThreadId),
        });

        restoreTransaction = {
          version: 1,
          kind: "checkpoint-restore",
          transactionId: randomUUID(),
          state: "prepared",
          sessionId: backupSessionId,
          backupSessionId,
          backupTurnId,
          sourceSessionId: source.sessionId,
          sourceTurnId: checkpoint.turnId,
          sourceCheckpointId: checkpoint.id,
          targetSessionId: targetThreadId,
          cwd,
          targetAfterSnapshotId: checkpoint.afterSnapshotId,
          backupAfterSnapshotId: backupAfter.id,
          createdAt: Date.now(),
        };
        // This append is the durable intent point. A crash after it can be
        // repaired on startup by replaying the complete backup pair.
        backup.appendEntry(TURN_RESTORE_TRANSACTION_CUSTOM_TYPE, restoreTransaction);

        restoreAttempted = true;
        await workspaceGit.restoreWorkspaceSnapshot(cwd, checkpoint.afterSnapshotId, {
          target: { sessionId: source.sessionId, turnId: checkpoint.turnId },
          rollback: { sessionId: backupSessionId, turnId: backupTurnId },
          onPhase: (phase) => journal(phase === "apply-started"
            ? "applying"
            : phase === "cleaned"
              ? "cleaned"
              : phase === "applied"
                ? "workspace-applied"
                : "rolling-back"),
        });
        git.invalidate(cwd);
        journal("workspace-applied");

        activated = await prepared.activate();
        prepared = undefined;
        // Keep the successfully restored branch as the most recent durable
        // session. Restore backups remain indexed and discoverable, but a
        // restart must resume the restored checkpoint rather than reopening
        // the backup solely because its transaction journal was written last.
        void target.appendInfo(`Restored to turn ${checkpoint.turnId.slice(0, 12)}`);
        journal("committed");
        restoreCommitted = true;
        await prioritizeRestoreTargetSession(targetPath, backupPath).catch((error) => {
          // The content commit is already durable. A failed timestamp update
          // must not roll it back; index recovery can still discover both
          // sessions and the target remains the active runtime in this host.
          services.log("restore.target-mtime.failed", errorMessage(error));
        });
        services.log("restore.completed", `${Math.round(performance.now() - startedAt)}ms`);
      } catch (error) {
        const recoveryErrors: unknown[] = [];
        let recovered = false;
        if (!restoreCommitted && restoreAttempted && backupSessionId && backupTurnId) {
          try {
            await workspaceGit.restoreWorkspaceSnapshot(cwd, turnSnapshotRef(backupSessionId, backupTurnId, "after"), {
              target: { sessionId: backupSessionId, turnId: backupTurnId },
              rollback: { sessionId: source.sessionId, turnId: checkpoint.turnId },
            });
            git.invalidate(cwd);
            recovered = true;
          } catch (recoveryError) {
            recoveryErrors.push(recoveryError);
          }
        }
        await cleanupTarget();
        if (recovered && restoreTransaction && backup) {
          try { journal("recovered"); } catch (journalError) { recoveryErrors.push(journalError); }
        }
        await cleanupUncommittedBackup();
        const message = errorMessage(error);
        if (recoveryErrors.length > 0) {
          throw new AggregateError([error, ...recoveryErrors], `Restore failed and workspace rollback needs attention: ${message}`, { cause: error });
        }
        throw new Error(`Restore failed; the original thread and workspace were kept unchanged. ${message}`, { cause: error });
      } finally {
        restoringCwd = undefined;
        await lease?.release();
      }
      // The backup must stay indexed as its own thread. The index sweep takes
      // the workspace lease, so it runs only after the restore released it.
      const index = await services.sessions.refreshIndex();
      return { ...activated!, updates: [index, ...activated!.updates] };
    });
  };

  /** Records without HEAD, read again once each; they never change. */
  const revisions = new Map<string, Promise<StoredTurnCheckpoint>>();
  const revise = async (cwd: string, checkpoints: readonly StoredTurnCheckpoint[]): Promise<StoredTurnCheckpoint[]> => {
    let reflog: Promise<ReflogEntry[] | undefined> | undefined;
    return Promise.all(checkpoints.map((checkpoint) => {
      if (checkpoint.head) return checkpoint;
      const key = `${checkpoint.sessionId}/${checkpoint.id}`;
      let revision = revisions.get(key);
      if (!revision) {
        if (revisions.size >= 5_000) revisions.clear();
        reflog ??= readHeadReflog(cwd).catch(() => undefined);
        revision = reflog.then((entries) => reviseLegacyCheckpoint(cwd, checkpoint, entries)).then((next) => {
          if (next !== checkpoint) {
            services.log("turn.checkpoint.revised", `${checkpoint.id}: ${checkpoint.fileCount ?? checkpoint.files.length} → ${next.fileCount} files, HEAD moved`);
            try { options.revised?.(checkpoint.sessionId, next); } catch { /* stats are best effort */ }
          }
          return next;
        }, () => checkpoint);
        revisions.set(key, revision);
      }
      return revision;
    }));
  };

  const historical = async (sessionId: string, checkpointId: string) => {
    const thread = services.thread(sessionId);
    if (!thread) throw new Error("That thread is not open any more. Open it again to continue.");
    const recorded = checkpointsOf(thread.entries(), sessionId).find((entry) => entry.id === checkpointId);
    const checkpoint = recorded ? (await revise(thread.cwd, [recorded]))[0] : undefined;
    const feature = features.get(sessionId)?.feature;
    return { thread, checkpoint, feature };
  };

  // A checkpoint whose refs were pruned (a fresh clone, a manual `git update-ref -d`)
  // cannot be inherited; the fork goes on without it instead of failing.
  const hasSnapshotRefs = options.hasSnapshotRefs ?? (async (cwd: string, checkpoint: StoredTurnCheckpoint) => {
    try {
      await workspaceGit.validateWorkspaceSnapshotRefs(cwd, checkpoint.beforeSnapshotId, checkpoint.afterSnapshotId, { sessionId: checkpoint.sessionId, turnId: checkpoint.turnId });
      return true;
    } catch {
      return false;
    }
  });
  const withSnapshotRefs = async (cwd: string, checkpoints: readonly StoredTurnCheckpoint[]): Promise<StoredTurnCheckpoint[]> => {
    const kept: StoredTurnCheckpoint[] = [];
    for (const checkpoint of checkpoints) {
      if (await hasSnapshotRefs(cwd, checkpoint)) kept.push(checkpoint);
      else services.log("fork.checkpoint.skipped", `${checkpoint.id}: its snapshot refs are gone from ${cwd}`);
    }
    return kept;
  };
  /**
   * Rewinds the conversation and leaves every file alone: a branch that ends
   * at the checkpoint's answer becomes the thread on screen, like a fork, and
   * the source thread stays as it was, so nothing needs a backup.
   */
  const rewind = async (sessionId: string, checkpointId: string): Promise<HostActionResult> => {
    if (services.attachedRuntime()) throw new Error("Rewind is unavailable while Pi owns this thread. Use Fork instead.");
    return services.sessions.exclusive(async () => {
      const { source, sourceFile, sourceCheckpoints, checkpoint } = verifiedAnchor(sessionId, checkpointId);
      const target = services.sessions.open(sourceFile).branch(checkpoint.anchorMessageId);
      if (!target) throw new Error("Failed to create the rewound thread.");
      let prepared: Awaited<ReturnType<typeof services.sessions.prepare>> | undefined;
      let activated: HostActionResult;
      try {
        const inherited = await withSnapshotRefs(source.cwd, checkpointsForBranch(target.entries(), sourceCheckpoints));
        if (inherited.length > 0) {
          await maintenance.rehomeFork({
            cwd: source.cwd,
            sourceSessionId: source.sessionId,
            targetSessionId: target.sessionId,
            checkpoints: inherited,
            appendEntry: (customType, data) => { target.appendEntry(customType, data); },
            committedCheckpoints: () => checkpointsOf(target.entries(), target.sessionId),
          });
        }
        prepared = await services.sessions.prepare(target, { previousSessionFile: sourceFile });
        activated = await prepared.activate();
        prepared = undefined;
      } catch (error) {
        await prepared?.discard().catch(() => undefined);
        await workspaceGit.cleanupTurnCheckpointSessionRefs(source.cwd, target.sessionId).catch(() => undefined);
        await rm(target.path, { force: true }).catch(() => undefined);
        throw new Error(`Rewind failed; the thread was kept unchanged. ${errorMessage(error)}`, { cause: error });
      }
      target.appendInfo(`Rewound to turn ${checkpoint.turnId.slice(0, 12)}; files kept as they were`);
      services.log("rewind.completed", checkpoint.turnId);
      const index = await services.sessions.refreshIndex();
      return { ...activated, updates: [index, ...activated.updates] };
    });
  };

  const lifecycle: HostThreadLifecycle = {
    beforeWorkspace: (cwd) => recoverPendingRestoreTransactions(cwd),
    beforeOpen: async (session) => {
      // A previous process may have died after publishing a snapshot ref but
      // before appending its custom entry. Clean that incomplete phase before a
      // runtime can start another turn in the same session.
      const open = services.thread(session.sessionId);
      // Reopening a session that still has a runtime reads its file, which can
      // lag that runtime's journal. Root the sweep in both.
      const entries = open && open.sessionId === session.sessionId
        ? [...session.entries(), ...open.entries()]
        : session.entries();
      await maintenance.cleanupOrphanRefs(
        session.cwd || services.cwd(),
        session.sessionId,
        checkpointsOf(entries, session.sessionId),
        turnRestoreBackupsFromEntries(entries, session.sessionId),
      );
    },
    afterFork: async (source, target) => {
      // Pi reports idle as soon as the agent boundary settles, while capture
      // deliberately persists in the background. Flush that per-thread journal
      // before reading the source branch so a fork cannot miss the just-completed checkpoint.
      await features.get(source.sessionId)?.feature.close();
      if (!source.sessionFile) return;
      const sourceCheckpoints = checkpointsOf(services.sessions.open(source.sessionFile).entries(), source.sessionId);
      const inherited = await withSnapshotRefs(source.cwd, checkpointsForBranch(target.entries(), sourceCheckpoints));
      if (inherited.length === 0) return;
      await maintenance.rehomeFork({
        cwd: source.cwd,
        sourceSessionId: source.sessionId,
        targetSessionId: target.sessionId,
        checkpoints: inherited,
        appendEntry: (customType, data) => { target.appendEntry(customType, data); },
        committedCheckpoints: () => checkpointsOf(target.entries(), target.sessionId),
      });
    },
    beforeActivate: (thread) => restoreBackupWorkspaceOnOpen(thread),
    /**
     * A deleted thread's snapshot refs go now rather than at the next sweep:
     * the journal they belong to is gone, so nothing can read them again.
     */
    threadDeleted: async (sessionId, cwd) => {
      features.delete(sessionId);
      await maintenance.cleanupSessionRefs(cwd || services.cwd(), sessionId);
    },
    sweep: async ({ sessions, liveThreads, projectPaths, deleted }: HostSessionSweep) => {
      // Reconcile every journal against the namespaced snapshot refs. Both
      // sides of a session are roots: the file on disk and the live thread,
      // whose newest entries may not have reached that file yet.
      const claims = new Map<string, WorkspaceKitLiveCheckpointSession>();
      for (const session of sessions) {
        const record = sessionCheckpoints(session);
        if (record) claims.set(record.sessionId, record);
      }
      for (const thread of liveThreads) {
        if (thread.backendKind !== "pi") continue;
        const claim = claimOf(thread.sessionId, thread.cwd, thread.entries());
        const persisted = claims.get(thread.sessionId);
        claims.set(thread.sessionId, persisted ? mergeClaims(persisted, claim) : claim);
      }
      const live = [...claims.values()];
      const workspaces = new Map<string, string>();
      const remember = async (cwd: string) => {
        try { workspaces.set(await leaseManager.canonicalKey(cwd), cwd); } catch { /* invalid path */ }
      };
      for (const session of sessions) await remember(session.cwd || services.cwd());
      for (const thread of liveThreads) await remember(thread.cwd);
      // A project can outlive its last session in the persisted project
      // history; include those roots so pruning the final session is recovered.
      for (const path of projectPaths) await remember(path);
      await Promise.allSettled([...workspaces.values()].map((cwd) => maintenance.cleanupLiveRefs(cwd, live)));
      // Runtime eviction keeps persisted history; only a missing session file is deletion.
      await Promise.allSettled(deleted.map((session) => maintenance.cleanupSessionRefs(session.cwd, session.sessionId)));
    },
  };

  const turns: HostTurnObserver = {
    accepted: (sessionId, turnId, { deferBefore, expectsInput }) => {
      const record = features.get(sessionId);
      if (!record) return;
      record.deferred.set(turnId, deferBefore);
      record.feature.runtime.acceptUserTurn(turnId, { deferBefore, ...(expectsInput === undefined ? {} : { expectsInput }) });
    },
    prepare: async (sessionId, turnId) => { await features.get(sessionId)?.feature.runtime.prepare(turnId); },
    cancelled: async (sessionId, turnId) => { await features.get(sessionId)?.feature.runtime.reject(turnId); },
    ended: async (sessionId, turnId, outcome) => {
      const record = features.get(sessionId);
      if (!record) return;
      const started = record.feature.runtime.get(turnId)?.started ?? false;
      // A queued prompt is prepared at its own delivery boundary; only an idle
      // prompt whose run ended without a turn has nothing to keep.
      const drop = outcome === "failed" ? !started : !started && !(record.deferred.get(turnId) ?? false);
      if (drop) await record.feature.runtime.reject(turnId);
    },
    pending: (sessionId) => features.get(sessionId)?.feature.runtime.pendingCount ?? 0,
    reset: async (sessionId) => { await features.get(sessionId)?.feature.runtime.settle(); },
    closed: async (sessionId) => {
      const record = features.get(sessionId);
      if (!record) return;
      features.delete(sessionId);
      await record.feature.close();
    },
  };

  const runtimeExtension: RuntimeExtensionFactory = (pi, session) => {
    const record = featureFor(session.sessionId, session.cwd);
    return record.feature.createPiExtension({ nextTurnId: randomUUID, findAssistantAnchor: assistantAnchorForMessage })(pi);
  };

  const attachedInvoke = (sessionId: string, command: string, input: unknown) =>
    services.attachedRuntime(sessionId)?.invoke(WORKSPACE_HOST_EXTENSION_ID, command, input);

  return {
    lifecycle,
    turns,
    runtimeExtension,
    pinnedEntries: (thread) => checkpointsOf(thread.entries(), thread.sessionId).map((checkpoint) => checkpoint.anchorMessageId),
    checkpoints: async (sessionId) => {
      if (services.attachedRuntime(sessionId)) {
        const result = await attachedInvoke(sessionId, "checkpoints", { sessionId }) as Partial<WorkspaceCheckpointList> | undefined;
        return { checkpoints: Array.isArray(result?.checkpoints) ? result.checkpoints : [], restoreSupported: false };
      }
      const thread = services.thread(sessionId);
      if (!thread) {
        const stored = (await services.sessions.list()).find((session) => session.sessionId === sessionId);
        if (!stored) return { checkpoints: [], restoreSupported: false };
        return {
          checkpoints: (await revise(stored.cwd || services.cwd(), checkpointsOf(services.sessions.open(stored.path).entries(), sessionId))).map(cloneTurnCheckpoint),
          restoreSupported: false,
        };
      }
      return {
        checkpoints: (await revise(thread.cwd, checkpointsOf(thread.entries(), sessionId))).map(cloneTurnCheckpoint),
        restoreSupported: thread.backendKind === "pi",
      };
    },
    canRestore: async (sessionId, checkpointId) => {
      if (services.attachedRuntime()) return false;
      return services.sessions.exclusive(async () => {
        try { await verifiedRestoreCheckpoint(sessionId, checkpointId); return true; } catch { return false; }
      });
    },
    restorePreview: async (sessionId, checkpointId) => {
      if (services.attachedRuntime()) throw new Error("Restore is unavailable while Pi owns this thread.");
      return services.sessions.exclusive(async () => {
        const { source, checkpoint } = await verifiedRestoreCheckpoint(sessionId, checkpointId);
        return workspaceGit.previewWorkspaceRestore(
          source.cwd,
          checkpoint.beforeSnapshotId,
          checkpoint.afterSnapshotId,
          { sessionId: source.sessionId, turnId: checkpoint.turnId },
          { branch: branchOf(source.cwd) },
        );
      });
    },
    restore,
    rewind,
    turnFileDiff: async (sessionId, checkpointId, path, diffOptions) => {
      if (services.attachedRuntime(sessionId)) {
        await workspaceGit.assertWorkspacePath(services.cwd(), path);
        const result = await attachedInvoke(sessionId, "turn-file-diff", { sessionId, checkpointId, path, options: diffOptions });
        if (result && typeof result === "object" && Array.isArray((result as { hunks?: unknown }).hunks)) return result as UiFileDiff;
        return { path, added: 0, removed: 0, hunks: [], note: "Pi did not return this historical diff." };
      }
      const { thread, checkpoint, feature } = await historical(sessionId, checkpointId);
      await workspaceGit.assertWorkspacePath(thread.cwd, path);
      if (!checkpoint) return { path, added: 0, removed: 0, hunks: [], note: "This turn checkpoint is no longer available." };
      if (!feature) return { path, added: 0, removed: 0, hunks: [], note: "Turn checkpoint history is unavailable." };
      // Never fall back to the live workspace: an old card must not change when
      // a later turn edits the same file or commits the work.
      return feature.historicalDiff(thread.cwd, checkpoint, path, diffOptions);
    },
    turnFiles: async (sessionId, checkpointId, cursor, limit) => {
      if (services.attachedRuntime(sessionId)) {
        const result = await attachedInvoke(sessionId, "turn-files", { sessionId, checkpointId, cursor, limit });
        const page = (result && typeof result === "object" ? result : {}) as Partial<UiWorkspaceChangesPage> & { sessionId?: unknown; checkpointId?: unknown };
        if (page.sessionId !== sessionId || page.checkpointId !== checkpointId
          || !Array.isArray(page.files) || typeof page.fileCount !== "number" || typeof page.hasMore !== "boolean") {
          throw new Error("Pi returned an invalid historical file page.");
        }
        return page as UiWorkspaceChangesPage;
      }
      const { thread, checkpoint, feature } = await historical(sessionId, checkpointId);
      if (!checkpoint) throw new Error("This turn checkpoint is no longer available.");
      if (!feature) throw new Error("Turn checkpoint history is unavailable.");
      return feature.historicalFiles(thread.cwd, checkpoint, cursor, limit);
    },
  };
}

