import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  assistantAnchorForMessage,
  checkpointsForBranch,
  cloneTurnCheckpoint,
  createWorkspaceKitCheckpointFeature,
  createWorkspaceKitCheckpointMaintenance,
  turnCheckpointsFromEntries,
  TURN_CHECKPOINT_CUSTOM_TYPE,
  WorkspaceCheckpointLeaseManager,
  type DiffLoadOptions,
  type PiKitBridge,
  type UiFileDiff,
  type UiWorkspaceChangesPage,
} from "tau/host-extension";
import { CHECKPOINT_EVENT, type CheckpointEvent, type WorkspaceCheckpointList } from "./protocol.js";

/**
 * Workspace Kit inside a Pi runtime Tau does not own. Tau's own runtime gets
 * the same feature in-process (`registerRuntimeExtension` in `host.ts`); here
 * the kit captures the turn itself, appends the checkpoint to Pi's session and
 * answers the historical queries the host cannot serve while Pi owns the
 * thread. Restore stays a host operation and stays off (`restoreSupported`).
 */
export default function workspacePiExtension(pi: ExtensionAPI, bridge: PiKitBridge): void {
  // A checkpoint may finish after Pi has already switched to another session.
  // Keep the owning context by session/turn so background Git work can still
  // append to the correct session instead of following the mutable tail.
  const sessionContexts = new Map<string, ExtensionContext>();
  const turnContexts = new Map<string, ExtensionContext>();
  const leaseManager = new WorkspaceCheckpointLeaseManager();
  const maintenance = createWorkspaceKitCheckpointMaintenance(leaseManager);
  let previousSessionForFork: {
    sessionId: string;
    cwd: string;
    checkpoints: ReturnType<typeof turnCheckpointsFromEntries>;
  } | undefined;

  const contextForTurn = (turnId: string): ExtensionContext | undefined => turnContexts.get(turnId);
  const releaseTurnContext = (turnId: string): void => {
    const ctx = turnContexts.get(turnId);
    turnContexts.delete(turnId);
    if (!ctx) return;
    const sessionId = ctx.sessionManager.getSessionId();
    if (![...turnContexts.values()].some((candidate) => candidate.sessionManager.getSessionId() === sessionId)) {
      sessionContexts.delete(sessionId);
    }
  };
  const disposeSessionContext = (ctx: ExtensionContext): void => {
    const sessionId = ctx.sessionManager.getSessionId();
    for (const [turnId, candidate] of turnContexts) {
      if (candidate.sessionManager.getSessionId() === sessionId) turnContexts.delete(turnId);
    }
    sessionContexts.delete(sessionId);
  };
  const publish = (event: CheckpointEvent, ctx: ExtensionContext): void => bridge.publishEvent(CHECKPOINT_EVENT, event, ctx);

  const feature = createWorkspaceKitCheckpointFeature({
    contextForTurn: (turnId) => {
      const ctx = contextForTurn(turnId);
      if (!ctx) return undefined;
      const sessionId = ctx.sessionManager.getSessionId();
      sessionContexts.set(sessionId, ctx);
      turnContexts.set(turnId, ctx);
      return { cwd: ctx.cwd, sessionId };
    },
    leaseManager,
    maintenance,
    appendCheckpoint: async (stored, result, capture) => {
      const sessionId = result.beforeSnapshot.sessionId;
      const ctx = sessionId ? sessionContexts.get(sessionId) : undefined;
      if (!ctx || result.afterSnapshot.sessionId !== sessionId || result.beforeSnapshot.turnId !== capture.id
        || result.afterSnapshot.turnId !== capture.id) {
        throw new Error("Pi session snapshot ownership changed.");
      }
      if (turnCheckpointsFromEntries(ctx.sessionManager.getBranch(), sessionId).some((entry) => entry.id === stored.id)) return;
      // ExtensionContext deliberately exposes a read-only SessionManager. The
      // Pi action is the supported durable write seam and is synchronous: once
      // it returns the session entry has been appended to disk.
      if (!bridge.isCurrentSession(ctx)) throw new Error("Pi session is no longer active.");
      pi.appendEntry(TURN_CHECKPOINT_CUSTOM_TYPE, stored);
      if (!bridge.isCurrentSession(ctx)) return;
      try {
        publish({ type: "turn-checkpoint", sessionId: ctx.sessionManager.getSessionId(), checkpoint: cloneTurnCheckpoint(stored) }, ctx);
        // The checkpoint may anchor an otherwise empty assistant message. A
        // bounded snapshot re-announces that exact raw entry so the renderer can
        // retain the anchor instead of inventing a tail activity row.
        bridge.refreshSnapshot(ctx);
      } catch {
        // The session entry is already durable. A transient client/encoding
        // failure must not make lifecycle cleanup delete a valid checkpoint.
      }
    },
    onError: (_error, capture) => {
      const ctx = contextForTurn(capture.id);
      // Error details may contain prompt text or skill contents. Keep the
      // wire event useful without exposing those details to the renderer.
      if (ctx) publish({ type: "turn-checkpoint-error", sessionId: ctx.sessionManager.getSessionId(), turnId: capture.id, message: "Turn checkpoint capture failed." }, ctx);
    },
    onStatus: (status, capture) => {
      const ctx = contextForTurn(capture.id);
      if (ctx) publish({ type: "turn-checkpoint-status", sessionId: ctx.sessionManager.getSessionId(), turnId: capture.id, status }, ctx);
    },
    onReleased: (capture) => releaseTurnContext(capture.id),
  });

  const checkpointOf = (ctx: ExtensionContext, checkpointId: string) =>
    turnCheckpointsFromEntries(ctx.sessionManager.getBranch(), ctx.sessionManager.getSessionId())
      .find((entry) => entry.id === checkpointId);

  const historicalDiff = async (ctx: ExtensionContext, checkpointId: string, path: string, options?: DiffLoadOptions): Promise<UiFileDiff> => {
    const checkpoint = checkpointOf(ctx, checkpointId);
    if (!checkpoint) return { path, added: 0, removed: 0, hunks: [], note: "This turn checkpoint is no longer available." };
    return feature.historicalDiff(ctx.cwd, checkpoint, path, options);
  };

  const historicalFiles = async (
    ctx: ExtensionContext,
    checkpointId: string,
    cursor?: string,
    limit?: number,
  ): Promise<UiWorkspaceChangesPage & { sessionId: string; checkpointId: string }> => {
    const checkpoint = checkpointOf(ctx, checkpointId);
    if (!checkpoint) throw new Error("This turn checkpoint is no longer available.");
    const page = await feature.historicalFiles(ctx.cwd, checkpoint, cursor, limit);
    return { ...page, sessionId: checkpoint.sessionId, checkpointId };
  };

  bridge.registerCommand("checkpoints", async (ctx) => ({
    checkpoints: turnCheckpointsFromEntries(ctx.sessionManager.getBranch(), ctx.sessionManager.getSessionId()).map(cloneTurnCheckpoint),
    // Restoring means rewriting the session under Pi's own writer.
    restoreSupported: false,
  } satisfies WorkspaceCheckpointList));
  bridge.registerCommand("turn-file-diff", async (ctx, input) => {
    if (typeof input.checkpointId !== "string" || typeof input.path !== "string") throw new Error("turn-file-diff needs checkpointId and path.");
    return historicalDiff(ctx, input.checkpointId, input.path, (input.options ?? undefined) as DiffLoadOptions | undefined);
  });
  bridge.registerCommand("turn-files", async (ctx, input) => {
    if (typeof input.checkpointId !== "string") throw new Error("turn-files needs checkpointId.");
    return historicalFiles(ctx, input.checkpointId, typeof input.cursor === "string" ? input.cursor : undefined, typeof input.limit === "number" ? input.limit : undefined);
  });

  // Checkpoint cards anchor to assistant entries; a text-empty one stays visible when pinned.
  bridge.pinEntries((ctx) => turnCheckpointsFromEntries(ctx.sessionManager.getBranch(), ctx.sessionManager.getSessionId())
    .map((checkpoint) => checkpoint.anchorMessageId));

  bridge.observeUserTurns({
    accepted: (turnId, ctx) => {
      // Bind the accepted turn before its deferred Git operation can run. The
      // checkpoint extension's input/turn_start hooks will reuse this queued
      // id, even if another prompt is delivered first.
      turnContexts.set(turnId, ctx);
      sessionContexts.set(ctx.sessionManager.getSessionId(), ctx);
      feature.runtime.acceptUserTurn(turnId, { deferBefore: true });
    },
    failed: (turnId, ctx) => {
      void feature.runtime.reject(turnId);
      publish({ type: "turn-checkpoint-error", sessionId: ctx.sessionManager.getSessionId(), turnId, message: "Turn checkpoint capture failed." }, ctx);
    },
  });

  feature.createPiExtension({
    nextTurnId: randomUUID,
    findAssistantAnchor: assistantAnchorForMessage,
    bindTurnContext: (turnId, ctx) => {
      turnContexts.set(turnId, ctx);
      sessionContexts.set(ctx.sessionManager.getSessionId(), ctx);
    },
  })(pi);

  pi.on("session_start", async (event, ctx) => {
    // Settlement starts the old session's snapshot/summary writes but does not
    // hold Pi's session-switch lifecycle open. The adapter keeps the owning
    // session context, so those writes cannot drift onto the new session.
    const disposedContexts = [...new Set(sessionContexts.values())];
    await feature.runtime.close();
    for (const disposed of disposedContexts) disposeSessionContext(disposed);
    let inherited = event.reason === "fork" ? previousSessionForFork : undefined;
    // A fork rebuilds the Pi extension runtime, so closure state from the
    // source extension is not guaranteed to survive the session replacement.
    // The runtime supplies the source session file precisely for this handoff;
    // reread it after the source shutdown has durably appended its final entry.
    if (event.reason === "fork" && event.previousSessionFile) {
      const source = bridge.openSession(event.previousSessionFile);
      // The in-process carrier is still useful for runtimes that expose a
      // transiently unavailable source path during fork setup.
      if (source) {
        inherited = {
          sessionId: source.sessionId,
          cwd: source.cwd,
          checkpoints: turnCheckpointsFromEntries(source.entries, source.sessionId),
        };
      }
    }
    previousSessionForFork = undefined;
    if (ctx.mode !== "tui" || !ctx.sessionManager.getSessionFile()) return;
    const sessionId = ctx.sessionManager.getSessionId();
    await maintenance.cleanupOrphanRefs(ctx.cwd, sessionId, turnCheckpointsFromEntries(ctx.sessionManager.getBranch(), sessionId));
    const carried = inherited ? checkpointsForBranch(ctx.sessionManager.getBranch(), inherited.checkpoints) : [];
    if (!inherited || carried.length === 0) return;
    try {
      await maintenance.rehomeFork({
        cwd: ctx.cwd,
        sourceSessionId: inherited.sessionId,
        targetSessionId: sessionId,
        checkpoints: carried,
        appendEntry: (customType, data) => { pi.appendEntry(customType, data); },
        committedCheckpoints: () => turnCheckpointsFromEntries(ctx.sessionManager.getBranch(), sessionId),
      });
      bridge.refreshSnapshot(ctx);
    } catch (error) {
      ctx.ui.notify(`Turn checkpoint history could not be carried into the fork: ${String(error)}`, "error");
    }
  });

  pi.on("session_before_fork", (_event, ctx) => {
    // Keep a source carrier even if Pi performs the fork without emitting a
    // separate shutdown callback. The shutdown callback refreshes its entries
    // after any final checkpoint persistence has settled.
    previousSessionForFork = {
      sessionId: ctx.sessionManager.getSessionId(),
      cwd: ctx.cwd,
      checkpoints: turnCheckpointsFromEntries(ctx.sessionManager.getBranch(), ctx.sessionManager.getSessionId()),
    };
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    await feature.runtime.close();
    // Read the branch after the awaited settle: a checkpoint that was in the
    // final persistence phase must be part of a subsequent fork as well.
    previousSessionForFork = {
      sessionId,
      cwd: ctx.cwd,
      checkpoints: turnCheckpointsFromEntries(ctx.sessionManager.getBranch(), sessionId),
    };
    disposeSessionContext(ctx);
  });
}
