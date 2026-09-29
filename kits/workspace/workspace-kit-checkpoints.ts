import { randomUUID } from "node:crypto";
import type { ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { DiffLoadOptions, UiFileDiff, UiWorkspaceChanges, UiWorkspaceChangesPage } from "tau/host-extension";
import {
  createStoredTurnCheckpoint,
  createTurnCheckpointBatch,
  rehomeStoredTurnCheckpoint,
  TURN_CHECKPOINT_BATCH_CUSTOM_TYPE,
  TURN_CHECKPOINT_CUSTOM_TYPE,
  type StoredTurnCheckpoint,
  turnCheckpointsFromEntries,
  turnSnapshotRef,
} from "./turn-checkpoint-codec.js";
import { createTurnCheckpointAdapter, type TurnCheckpointAdapterOptions } from "./turn-checkpoint-adapter.js";
import { TurnCheckpointLifecycle } from "./turn-checkpoint-lifecycle.js";
import { attributeTurnChanges, headSteps, readHeadReflog, recordedAttribution } from "./turn-attribution.js";
import type {
  AcceptTurnOptions,
  TurnCaptureState,
  TurnChangesSummary,
  TurnHead,
  TurnCheckpointCaptureResult,
  TurnCheckpointLease,
  TurnCheckpointStatus,
  TurnRestoreBackup,
  TurnOutcomeEvent,
} from "./turn-checkpoint-types.js";
import { createPiTurnCheckpointExtension } from "./pi-turn-checkpoint-extension.js";
import * as workspaceGit from "./workspace-git.js";
import { WorkspaceCheckpointLeaseManager } from "./workspace-checkpoint-lease.js";

export interface WorkspaceKitCheckpointMaintenance {
  cleanupSessionRefs(cwd: string, sessionId: string): Promise<void>;
  cleanupOrphanRefs(cwd: string, sessionId: string, checkpoints: readonly StoredTurnCheckpoint[], backups?: readonly TurnRestoreBackup[]): Promise<void>;
  cleanupLiveRefs(cwd: string, sessions: readonly workspaceGit.LiveCheckpointSession[]): Promise<void>;
  rehomeFork(options: WorkspaceKitForkOptions): Promise<void>;
}

export type WorkspaceKitLiveCheckpointSession = workspaceGit.LiveCheckpointSession;

export interface WorkspaceKitForkOptions {
  cwd: string;
  sourceSessionId: string;
  targetSessionId: string;
  checkpoints: readonly StoredTurnCheckpoint[];
  /** Durable custom-entry seam. The feature appends the journal marker last. */
  appendEntry(customType: string, data: unknown): void | Promise<void>;
  /** Reads committed target entries after each append for crash-safe cleanup. */
  committedCheckpoints(): readonly StoredTurnCheckpoint[];
  /** The caller may already hold the workspace lease for a larger transaction. */
  lease?: TurnCheckpointLease;
}

/**
 * Owns the non-UI checkpoint maintenance paths as part of Workspace Kit. The
 * host and Pi bridge share this object rather than importing Git persistence or
 * fork transaction details into their runtime adapters.
 */
/**
 * How long ref housekeeping waits for a checkout another turn is holding.
 * Cleaning orphan refs is never urgent, and the caller may be opening a thread
 * from inside that very turn, so waiting for the lease would deadlock the host.
 */
export const MAINTENANCE_LEASE_TIMEOUT_MS = 2_000;

function leaseTimedOut(error: unknown): boolean {
  return error instanceof Error && error.message.includes("Timed out waiting for the workspace checkpoint lease");
}

export function createWorkspaceKitCheckpointMaintenance(
  leaseManager = new WorkspaceCheckpointLeaseManager(),
  options: { maintenanceLeaseTimeoutMs?: number; onSkipped?(cwd: string, sessionId: string): void } = {},
): WorkspaceKitCheckpointMaintenance {
  const withLease = async <T>(
    cwd: string,
    sessionId: string,
    operation: () => Promise<T>,
    timeoutMs?: number,
  ): Promise<T | undefined> => {
    let lease;
    try {
      lease = await leaseManager.acquire(cwd, {
        sessionId,
        turnId: `maintenance-${randomUUID()}`,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
    } catch (error) {
      if (timeoutMs !== undefined && leaseTimedOut(error)) {
        options.onSkipped?.(cwd, sessionId);
        return undefined;
      }
      throw error;
    }
    try {
      return await operation();
    } finally {
      await lease.release();
    }
  };
  const timeout = options.maintenanceLeaseTimeoutMs ?? MAINTENANCE_LEASE_TIMEOUT_MS;
  const sweep = async <T>(cwd: string, sessionId: string, operation: () => Promise<T>): Promise<void> => {
    await withLease(cwd, sessionId, operation, timeout);
  };
  return {
    cleanupSessionRefs: (cwd, sessionId) => sweep(cwd, sessionId, () => workspaceGit.cleanupTurnCheckpointSessionRefs(cwd, sessionId)),
    cleanupOrphanRefs: (cwd, sessionId, checkpoints, backups) => sweep(cwd, sessionId, () => workspaceGit.cleanupOrphanTurnCheckpointRefs(cwd, sessionId, checkpoints, undefined, backups)),
    cleanupLiveRefs: (cwd, sessions) => sweep(cwd, "tau-checkpoint-gc", () => workspaceGit.cleanupCheckpointRefsForLiveSessions(cwd, sessions)),
    rehomeFork: async ({ cwd, sourceSessionId, targetSessionId, checkpoints, appendEntry, committedCheckpoints, lease }) => {
      const operation = async () => {
        if (checkpoints.length === 0) return;
        const transactionId = randomUUID();
        try {
          await workspaceGit.cloneTurnCheckpointRefs(cwd, sourceSessionId, targetSessionId, checkpoints);
          const existing = new Set(committedCheckpoints().map((checkpoint) => checkpoint.id));
          const appendedIds: string[] = [];
          for (const checkpoint of checkpoints) {
            if (existing.has(checkpoint.id)) continue;
            await appendEntry(
              TURN_CHECKPOINT_CUSTOM_TYPE,
              rehomeStoredTurnCheckpoint(checkpoint, targetSessionId, transactionId),
            );
            appendedIds.push(checkpoint.id);
          }
          if (appendedIds.length > 0) {
            await appendEntry(
              TURN_CHECKPOINT_BATCH_CUSTOM_TYPE,
              createTurnCheckpointBatch(transactionId, targetSessionId, appendedIds),
            );
          }
        } catch (error) {
          // The journal marker is the commit point. Only entries that are already
          // committed in the target branch protect cloned refs from rollback.
          // If the journal cannot be read, do not guess: deleting all target
          // refs could destroy a checkpoint that was durably appended just
          // before the read failed. Startup orphan recovery can inspect the
          // journal again under the same workspace lease.
          let committed: readonly StoredTurnCheckpoint[];
          try {
            committed = committedCheckpoints();
          } catch {
            throw error;
          }
          await workspaceGit.cleanupClonedTurnCheckpointRefs(
            cwd,
            sourceSessionId,
            targetSessionId,
            checkpoints,
            undefined,
            committed,
          ).catch(() => undefined);
          throw error;
        }
      };
      // A fork's inheritance is a transaction, not housekeeping: it waits.
      await (lease ? operation() : withLease(cwd, targetSessionId, operation));
    },
  };
}

/** The transport-neutral identity needed by the Workspace Kit capture owner. */
export interface WorkspaceKitTurnContext {
  cwd: string;
  sessionId: string;
}

/**
 * The host only needs a typed runtime seam. The state machine and its lifecycle
 * remain private to Workspace Kit, so a core host cannot accidentally grow a
 * second checkpoint implementation or persist feature state itself.
 */
export interface WorkspaceKitCheckpointRuntime {
  readonly pendingCount: number;
  get(id: string): TurnCaptureState<workspaceGit.WorkspaceSnapshot> | undefined;
  acceptUserTurn(id: string, options?: AcceptTurnOptions): TurnCaptureState<workspaceGit.WorkspaceSnapshot>;
  prepare(id: string): Promise<void>;
  acceptInput(id?: string, options?: { deferBefore?: boolean }): Promise<TurnCaptureState<workspaceGit.WorkspaceSnapshot>>;
  beginTurn(): Promise<TurnCaptureState<workspaceGit.WorkspaceSnapshot> | undefined>;
  userMessage(): Promise<TurnCaptureState<workspaceGit.WorkspaceSnapshot> | undefined>;
  endTurn(message: unknown, anchorMessageId?: string, resolveAnchor?: () => string | undefined): Promise<void>;
  endAgent(event: TurnOutcomeEvent): Promise<void>;
  reject(id?: string): Promise<void>;
  settle(options?: { final?: boolean }): Promise<void>;
  close(): Promise<void>;
}

export interface WorkspaceKitPiExtensionOptions {
  nextTurnId(): string;
  findAssistantAnchor(ctx: ExtensionContext, message: unknown): string | undefined;
  bindTurnContext?(turnId: string, ctx: ExtensionContext): void;
}

export interface WorkspaceKitCheckpointFeatureOptions {
  /** Resolves the session/workspace that accepted a client turn. */
  contextForTurn(turnId: string): WorkspaceKitTurnContext | undefined;
  /** Branch name is presentation metadata and is intentionally not persisted as state. */
  branchForWorkspace?(cwd: string): string | undefined;
  /** The owning runtime supplies the durable custom-entry transport. */
  appendCheckpoint(
    checkpoint: StoredTurnCheckpoint,
    result: TurnCheckpointCaptureResult<workspaceGit.WorkspaceSnapshot>,
    capture: TurnCaptureState<workspaceGit.WorkspaceSnapshot>,
  ): Promise<void>;
  leaseManager?: WorkspaceCheckpointLeaseManager;
  maintenance?: WorkspaceKitCheckpointMaintenance;
  /** Defaults to `DEFAULT_LEASE_TIMEOUT_MS`; a busy workspace skips the checkpoint instead of delaying Pi. */
  leaseTimeoutMs?: number;
  onError?(error: unknown, capture: TurnCaptureState<workspaceGit.WorkspaceSnapshot>): void;
  onStatus?(status: TurnCheckpointStatus, capture: TurnCaptureState<workspaceGit.WorkspaceSnapshot>): void;
  onReleased?(capture: TurnCaptureState<workspaceGit.WorkspaceSnapshot>): void | Promise<void>;
}

/**
 * The Workspace Kit owns the complete optional checkpoint feature: immutable
 * snapshot capture, Git summary/history access, lifecycle state, and durable
 * record construction. Pi host and bridge are only adapters for their runtime
 * context, custom-entry transport, and event delivery.
 */
export interface WorkspaceKitCheckpointFeature {
  readonly runtime: WorkspaceKitCheckpointRuntime;
  readonly checkpointsFromEntries: typeof turnCheckpointsFromEntries;
  readonly maintenance: WorkspaceKitCheckpointMaintenance;
  /** Pi event translation is supplied by the same Workspace Kit owner. */
  createPiExtension(options: WorkspaceKitPiExtensionOptions): ExtensionFactory;
  historicalDiff(
    cwd: string,
    checkpoint: StoredTurnCheckpoint,
    path: string,
    options?: DiffLoadOptions,
  ): Promise<UiFileDiff>;
  historicalFiles(
    cwd: string,
    checkpoint: StoredTurnCheckpoint,
    cursor?: string,
    limit?: number,
  ): Promise<UiWorkspaceChangesPage>;
  close(): Promise<void>;
}

/**
 * Leaves out what a branch switch, pull or reset during the turn changed.
 * Plain-folder snapshots carry no HEAD and stay as they are.
 */
export async function attributeSnapshotPair(
  cwd: string,
  changes: UiWorkspaceChanges,
  before: workspaceGit.WorkspaceSnapshot,
  after: workspaceGit.WorkspaceSnapshot,
): Promise<TurnChangesSummary> {
  if (before.head === undefined || after.head === undefined) return changes;
  const head: TurnHead = {
    before: before.head,
    after: after.head,
    ...(before.headBranch ? { beforeBranch: before.headBranch } : {}),
    ...(after.headBranch ? { afterBranch: after.headBranch } : {}),
  };
  if (head.before === head.after) return { ...changes, head };
  const reflog = await readHeadReflog(cwd).catch(() => undefined);
  const steps = reflog ? headSteps(reflog, head) : undefined;
  return attributeTurnChanges(cwd, changes, { beforeTree: before.id, afterTree: after.id, head, steps });
}

/** A checkpoint whose HEAD moved pages only the files it kept. */
export function pageAttribution(cwd: string, checkpoint: StoredTurnCheckpoint): Pick<workspaceGit.SnapshotPageOptions, "attribute"> {
  const { head, headMove } = checkpoint;
  if (!head || !headMove) return {};
  return { attribute: (changes) => attributeTurnChanges(cwd, changes, recordedAttribution({ ...checkpoint, head, headMove })) };
}

/**
 * Long enough for a neighbouring turn's persist or a ref sweep to finish, short
 * enough that a parallel thread in the same worktree feels instant.
 */
export const DEFAULT_LEASE_TIMEOUT_MS = 1_000;

/** Creates the one shared Workspace Kit feature instance used by host and Pi bridge. */
export function createWorkspaceKitCheckpointFeature(
  options: WorkspaceKitCheckpointFeatureOptions,
): WorkspaceKitCheckpointFeature {
  const leaseManager = options.leaseManager ?? new WorkspaceCheckpointLeaseManager();
  const maintenance = options.maintenance ?? createWorkspaceKitCheckpointMaintenance(leaseManager);
  const adapterOptions: TurnCheckpointAdapterOptions<workspaceGit.WorkspaceSnapshot> = {
    sessionIdForTurn: (turnId) => options.contextForTurn(turnId)?.sessionId,
    createBefore: async (turnId) => {
      const context = options.contextForTurn(turnId);
      return context
        ? workspaceGit.createTurnWorkspaceSnapshot(context.cwd, context.sessionId, turnId, "before")
        : undefined;
    },
    createAfter: async (turnId) => {
      const context = options.contextForTurn(turnId);
      return context
        ? workspaceGit.createTurnWorkspaceSnapshot(context.cwd, context.sessionId, turnId, "after")
        : undefined;
    },
    acquireLease: async (turnId, signal): Promise<TurnCheckpointLease | undefined> => {
      const context = options.contextForTurn(turnId);
      if (!context) return undefined;
      return leaseManager.acquire(context.cwd, { sessionId: context.sessionId, turnId, signal });
    },
    summarize: async (before, after, turnId): Promise<TurnChangesSummary> => {
      const beforeContext = options.contextForTurn(turnId);
      if (!beforeContext || before.cwd !== after.cwd || before.sessionId !== after.sessionId
        || before.turnId !== turnId || after.turnId !== turnId) {
        throw new Error("Workspace checkpoint snapshot ownership changed.");
      }
      const changes = await workspaceGit.diffWorkspaceSnapshots(beforeContext.cwd, before.id, after.id, {
        branch: options.branchForWorkspace?.(beforeContext.cwd),
        expected: { sessionId: beforeContext.sessionId, turnId },
      });
      return attributeSnapshotPair(beforeContext.cwd, changes, before, after);
    },
    discardSnapshot: (snapshot) => {
      const cwd = snapshot.cwd ?? options.contextForTurn(snapshot.turnId ?? "")?.cwd;
      if (!cwd) return;
      return workspaceGit.deleteWorkspaceSnapshot(
        cwd,
        snapshot.id,
        snapshot.sessionId && snapshot.turnId && snapshot.phase
          ? { sessionId: snapshot.sessionId, turnId: snapshot.turnId, phase: snapshot.phase, treeId: snapshot.treeId }
          : undefined,
      );
    },
    discardTurnSnapshot: (turnId, phase) => {
      const context = options.contextForTurn(turnId);
      if (!context) return;
      return workspaceGit.deleteWorkspaceSnapshot(
        context.cwd,
        turnSnapshotRef(context.sessionId, turnId, phase),
        { sessionId: context.sessionId, turnId, phase },
      );
    },
    appendCheckpoint: async (checkpoint, result, capture) => {
      // Keep canonical entry construction in this shared Workspace Kit owner;
      // host and bridge only implement their synchronous/remote write seam.
      const sessionId = options.contextForTurn(capture.id)?.sessionId;
      if (!sessionId) throw new Error("The turn checkpoint session is unavailable.");
      const canonical = createStoredTurnCheckpoint(result, capture, sessionId);
      if (canonical.id !== checkpoint.id || canonical.beforeSnapshotId !== checkpoint.beforeSnapshotId
        || canonical.afterSnapshotId !== checkpoint.afterSnapshotId) {
        throw new Error("The turn checkpoint adapter returned a non-canonical record.");
      }
      await options.appendCheckpoint(checkpoint, result, capture);
    },
    ...(options.onError ? { onError: options.onError } : {}),
    ...(options.onStatus ? { onStatus: options.onStatus } : {}),
    ...(options.onReleased ? { onReleased: options.onReleased } : {}),
  };
  const lifecycle = new TurnCheckpointLifecycle<workspaceGit.WorkspaceSnapshot>(
    createTurnCheckpointAdapter(adapterOptions),
    { leaseTimeoutMs: options.leaseTimeoutMs ?? DEFAULT_LEASE_TIMEOUT_MS },
  );
  const runtime: WorkspaceKitCheckpointRuntime = {
    get: (id) => lifecycle.get(id),
    acceptUserTurn: (id, acceptOptions) => lifecycle.acceptUserTurn(id, acceptOptions),
    prepare: (id) => lifecycle.prepare(id),
    acceptInput: (id, acceptOptions) => lifecycle.acceptInput(id, acceptOptions),
    beginTurn: () => lifecycle.beginTurn(),
    userMessage: () => lifecycle.userMessage(),
    endTurn: (message, anchorMessageId, resolveAnchor) => lifecycle.endTurn(message, anchorMessageId, resolveAnchor),
    endAgent: (event) => lifecycle.endAgent(event),
    reject: (id) => lifecycle.reject(id),
    settle: (settleOptions) => lifecycle.settle(settleOptions),
    close: () => lifecycle.close(),
    get pendingCount() { return lifecycle.pendingCount; },
  };

  const feature: WorkspaceKitCheckpointFeature = {
    runtime,
    checkpointsFromEntries: turnCheckpointsFromEntries,
    maintenance,
    createPiExtension: (extensionOptions) => createPiTurnCheckpointExtension({ lifecycle, ...extensionOptions }),
    historicalDiff: async (cwd, checkpoint, path, diffOptions) => {
      await workspaceGit.assertWorkspacePath(cwd, path);
      return workspaceGit.getSnapshotFileDiff(
        cwd,
        checkpoint.beforeSnapshotId,
        checkpoint.afterSnapshotId,
        path,
        diffOptions,
        { sessionId: checkpoint.sessionId, turnId: checkpoint.turnId },
      );
    },
    historicalFiles: async (cwd, checkpoint, cursor, limit) => workspaceGit.diffWorkspaceSnapshotPage(
      cwd,
      checkpoint.beforeSnapshotId,
      checkpoint.afterSnapshotId,
      {
        sessionId: checkpoint.sessionId,
        turnId: checkpoint.turnId,
        branch: checkpoint.branch,
        cursor,
        limit,
        ...pageAttribution(cwd, checkpoint),
      },
    ),
    close: () => lifecycle.close(),
  };
  return feature;
}
