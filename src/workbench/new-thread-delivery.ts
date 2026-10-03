import type { HostSnapshot, NewThreadRequestId, UiMessage } from "../shared/contracts";
import type { HostUpdate } from "../shared/host-protocol";
import {
  backgroundNewThreadDetail,
  isSameUserMessage,
  mergeNewThreadRecoveryAttachments,
  mergeNewThreadRecoveryDraft,
  transcriptNavigationScopeKey,
  type NewThreadSubmissionRecovery,
} from "./app-state";
import type { ClientStorage } from "./client-storage";
import { createDraftKey, type ComposerScopeStore, type DraftKey } from "./composer-scope-store";
import { draftKey, writeComposerDraft, writeNewThreadDraft, type NewThreadDraft } from "./draft-store";
import { errorMessage } from "./error-message";
import type { ThreadStore } from "./thread-store";
import type { ThreadViewStore } from "./thread-view-store";
import type { TranscriptTurnPort } from "./turn-scope";

/** The part of the pending-draft controller delivery promotion needs. */
export interface NewThreadDeliveryDraftPort {
  current(): NewThreadDraft | undefined;
  set(draft: NewThreadDraft | undefined): void;
  promoteFromUserMessage(sessionId: string, projectPath: string): DraftKey | undefined;
}

/**
 * The workbench state that a delivery may move between. Keeping this as one
 * capability makes the coordinator independent of React and of the renderer
 * controller that submits the prompt.
 */
export interface NewThreadDeliveryProjection {
  view: ThreadViewStore;
  threads: ThreadStore;
  scopes: ComposerScopeStore;
  storage: ClientStorage;
  newThread: NewThreadDeliveryDraftPort;
  turn: TranscriptTurnPort;
  retainDraftRow?(draftId: string, sessionId: string): void;
}

/** The renderer adapts its extension registry to this one notification. */
export interface NewThreadDeliveryNotificationPort {
  notifyPromptSubmitted(event: { prompt: string; snapshot?: HostSnapshot }): boolean | Promise<void>;
}

export interface NewThreadDeliveryPorts {
  projection: NewThreadDeliveryProjection;
  notification: NewThreadDeliveryNotificationPort;
}

/**
 * State changes that are safe to make before the workbench applies a
 * correlated detail. A delivery can name a runtime session before that
 * session's first detail is available; the session owns applying the detail
 * and then finishing this plan.
 */
export interface NewThreadDeliveryPromotion {
  status: "none" | "rejected" | "promoted";
  promoted: boolean;
  clientMessageId?: string;
  detail?: HostUpdate;
  prompt?: string;
}

export interface NewThreadDeliverySettlement {
  handled: boolean;
  promotion?: NewThreadDeliveryPromotion;
}

/** Stable delivery capability exposed by WorkbenchSession to renderer edges. */
export interface NewThreadDeliveryPort {
  register(clientMessageId: string, recovery: NewThreadSubmissionRecovery): void;
  hasRecovery(clientMessageId: string): boolean;
  recoveryScope(clientMessageId: string): string | undefined;
  markWithoutUserTurn(clientMessageId: string): void;
  markIpcSettled(clientMessageId: string, recovery?: NewThreadSubmissionRecovery): void;
  promoteReportedThread(sessionId: string, message: UiMessage, requestId?: NewThreadRequestId): boolean;
  promoteRecovery(clientMessageId: string, sessionId: string, message?: UiMessage): boolean;
  settleDelivery(
    clientMessageId: string,
    sessionId: string,
    settlement: { accepted: true } | { accepted: false; message: string },
  ): boolean;
  detachPendingDelivery(): boolean;
  release(clientMessageId: string): void;
  rehomeDetached(clientMessageId: string, recovery: NewThreadSubmissionRecovery, sessionId: string): void;
  notifyPromptSubmitted(
    pending: NewThreadDraft,
    sessionId: string,
    prompt: string,
    recovery?: NewThreadSubmissionRecovery,
  ): void;
}

/**
 * Correlates a new thread's first message from submission through host
 * acknowledgement. The coordinator owns the recovery record and its terminal
 * transitions; callers only provide prompt setup or route host events here.
 */
export class NewThreadDeliveryCoordinator {
  private readonly recoveries = new Map<string, NewThreadSubmissionRecovery>();

  constructor(private readonly ports: NewThreadDeliveryPorts) {}

  register(clientMessageId: string, recovery: NewThreadSubmissionRecovery): void {
    this.recoveries.set(clientMessageId, recovery);
  }

  hasRecovery = (clientMessageId: string): boolean => this.recoveries.has(clientMessageId);

  recoveryScope = (clientMessageId: string): string | undefined => this.recoveries.get(clientMessageId)?.scopeRef.scope;

  /** The host answered this prompt without persisting a user turn. */
  markWithoutUserTurn = (clientMessageId: string): void => {
    const recovery = this.recoveries.get(clientMessageId);
    if (recovery) recovery.withoutUserTurn = true;
  };

  markIpcSettled = (clientMessageId: string, recovery?: NewThreadSubmissionRecovery): void => {
    const current = recovery ?? this.recoveries.get(clientMessageId);
    if (current) current.ipcPending = false;
  };

  /**
   * A host-reported thread carries either the persisted client message or the
   * request id attached to the new-thread call. Request identity wins over
   * prompt text, including when a detail is delivered before IPC resolves.
   */
  promoteReportedThread = (sessionId: string, message: UiMessage, requestId?: NewThreadRequestId): NewThreadDeliveryPromotion => {
    const byRequest = requestId
      ? [...this.recoveries.entries()].find(([, recovery]) => recovery.requestId === requestId)?.[0]
      : undefined;
    const reported = message.clientMessageId;
    const clientMessageId = reported !== undefined && this.recoveries.has(reported) ? reported : byRequest;
    return clientMessageId
      ? this.promoteRecovery(clientMessageId, sessionId, message)
      : { status: "none", promoted: false };
  };

  /**
   * Commit a new-thread delivery without changing whichever thread is visible.
   * The returned detail is applied by WorkbenchSession, which keeps delivery
   * from reaching back into WorkbenchStore while that store is already
   * reducing a host update.
   */
  promoteRecovery = (clientMessageId: string, sessionId: string, message?: UiMessage): NewThreadDeliveryPromotion => {
    const { view, threads, scopes, newThread, turn } = this.ports.projection;
    const recovery = this.recoveries.get(clientMessageId);
    if (!recovery) return { status: "none", promoted: false };
    if (recovery.failed) return { status: "rejected", promoted: false, clientMessageId };
    if (recovery.sessionId && recovery.sessionId !== sessionId) {
      return { status: "rejected", promoted: false, clientMessageId };
    }
    const keepInBackground = recovery.detached && threads.getSnapshot().activeThreadId !== sessionId;
    // A detached delivery must not reclaim the visible new-thread controller.
    const promotedScope = recovery.detached ? undefined : newThread.promoteFromUserMessage(sessionId, recovery.pending.projectPath);
    if (!promotedScope && !recovery.detached && recovery.sessionId !== sessionId) {
      return { status: "rejected", promoted: false, clientMessageId };
    }
    recovery.sessionId = sessionId;
    recovery.promoted = true;
    if (message && !recovery.detached) this.ports.projection.retainDraftRow?.(recovery.pending.draftId, sessionId);
    scopes.moveScope(recovery.scopeRef.scope, createDraftKey(draftKey(sessionId)));
    if (message) {
      retargetOptimisticByClientMessageId(view, clientMessageId, `session:${sessionId}`);
    } else {
      removeOptimisticByClientMessageId(view, clientMessageId);
    }

    const turnStart = turn.current();
    if (turnStart?.clientMessageId === clientMessageId) {
      turn.set(message ? {
        ...turnStart,
        sessionId,
        scope: { kind: "session", projectPath: recovery.pending.projectPath, sessionId },
        scopeKey: transcriptNavigationScopeKey({ cwd: recovery.pending.projectPath, sessionId }),
      } : undefined, turnStart.turnId);
    }

    if (keepInBackground) {
      if (message) {
        view.details.set(backgroundNewThreadDetail(view.details.get(sessionId), sessionId, message));
        threads.setThreadRunning(sessionId, true);
      } else {
        threads.setThreadRunning(sessionId, false);
      }
    } else if (!message) {
      // An extension command answered the prompt without a user turn and
      // without an agent run. The thread exists; nothing is in flight in it.
      threads.setActiveThread(sessionId, false);
    } else if (!view.details.get(sessionId)?.messages.some((entry) => isSameUserMessage(entry, message))) {
      // A blank detail may have arrived before this event. Let the session
      // apply the synthetic detail through the normal store path. The
      // recovery remains held until the session finishes the returned plan.
      return {
        status: "promoted",
        promoted: true,
        clientMessageId,
        prompt: message.text || recovery.draft,
        detail: {
          version: 1,
          type: "thread-detail",
          detail: { sessionId, messages: [message], isStreaming: true, activeTools: [] },
        },
      };
    } else {
      threads.setActiveThread(sessionId, true);
    }
    return { status: "promoted", promoted: true, clientMessageId, prompt: message?.text || recovery.draft };
  };

  /** Complete a promotion after its optional correlated detail was applied. */
  finishPromotion = (promotion: NewThreadDeliveryPromotion): boolean => {
    if (!promotion.promoted || !promotion.clientMessageId) return false;
    const recovery = this.recoveries.get(promotion.clientMessageId);
    if (!recovery) return false;
    this.notifyPromptSubmitted(recovery.pending, recovery.sessionId ?? "", promotion.prompt ?? recovery.draft, recovery);
    // Delivery acceptance is the commit point. The later IPC acknowledgement
    // must not keep thread navigation blocked and is safe because this record
    // is already promoted before the result can arrive.
    this.release(promotion.clientMessageId);
    return true;
  };

  /** The host's own verdict on a delivery, whichever thread is on screen. */
  settleDeliveryPlan = (
    clientMessageId: string,
    sessionId: string,
    settlement: { accepted: true } | { accepted: false; message: string },
  ): NewThreadDeliverySettlement => {
    const recovery = this.recoveries.get(clientMessageId);
    if (!recovery) return { handled: false };
    if (settlement.accepted) {
      const promotion = this.promoteRecovery(
        clientMessageId,
        sessionId,
        recovery.withoutUserTurn ? undefined : recovery.optimistic,
      );
      // A committed delivery is finished by WorkbenchSession after reducing
      // the optional detail. A stale settlement (for example, an old session
      // id after rehoming) must leave the live recovery held for the matching
      // report.
      return { handled: true, promotion };
    }
    recovery.failed = settlement.message || "The runtime rejected the message.";
    this.restoreFailed(recovery, sessionId);
    // A failed delivery is safe to release once its IPC acknowledgement has
    // arrived; until then the late accepted result must not clear recovery.
    if (!recovery.ipcPending) this.release(clientMessageId);
    return { handled: true };
  };

  /**
   * Leaving a draft never waits for its first message: delivery continues in
   * the background and follows the runtime thread once the host names one.
   */
  detachPendingDelivery = (): boolean => {
    const pending = this.ports.projection.newThread.current();
    if (!pending) return false;
    let detached = false;
    for (const [clientMessageId, recovery] of this.recoveries) {
      if (recovery.pending.draftId !== pending.draftId || recovery.detached) continue;
      recovery.detached = true;
      detached = true;
      if (recovery.sessionId) this.rehomeDetached(clientMessageId, recovery, recovery.sessionId);
    }
    return detached;
  };

  release = (clientMessageId: string): void => {
    const recovery = this.recoveries.get(clientMessageId);
    if (!recovery) return;
    this.recoveries.delete(clientMessageId);
    this.ports.projection.scopes.releaseScopeReference(recovery.scopeRef);
  };

  /** Notify the extension layer at most once for a held delivery. */
  notifyPromptSubmitted(
    pending: NewThreadDraft,
    sessionId: string,
    prompt: string,
    recovery?: NewThreadSubmissionRecovery,
  ): void {
    if (recovery?.notified) return;
    const current = this.ports.projection.view.getSnapshot();
    const snapshot = current ? {
      ...current,
      cwd: pending.projectPath,
      sessionId,
      sessionName: undefined,
      sessionTitle: "Untitled thread",
      // Without an explicit draft choice, the model and runtime on screen
      // still belong to whichever thread was open before.
      model: pending.model,
      mode: pending.mode,
      backendKind: undefined,
      messages: [],
      isStreaming: false,
      activeTools: [],
      turnActivity: undefined,
      taskProgress: undefined,
      taskHistory: [],
    } : undefined;
    if (recovery) recovery.notified = true;
    let notification: boolean | Promise<void>;
    try {
      notification = this.ports.notification.notifyPromptSubmitted({ prompt, snapshot });
    } catch (error) {
      this.ports.projection.view.setNotice(errorMessage(error));
      return;
    }
    if (notification === false) {
      if (recovery) recovery.notified = false;
      return;
    }
    if (typeof notification !== "boolean") {
      void notification.catch((error: unknown) => this.ports.projection.view.setNotice(errorMessage(error)));
    }
  }

  /** Bind a detached delivery to its runtime thread once the host names it. */
  rehomeDetached = (clientMessageId: string, recovery: NewThreadSubmissionRecovery, sessionId: string): void => {
    recovery.sessionId = sessionId;
    this.ports.projection.scopes.moveScope(recovery.scopeRef.scope, createDraftKey(draftKey(sessionId)));
    retargetOptimisticByClientMessageId(this.ports.projection.view, clientMessageId, `session:${sessionId}`);
  };

  /** Put a rejected prompt back into the composer it came from. */
  private restoreSubmission(recovery: NewThreadSubmissionRecovery): void {
    const { scopes, storage, newThread } = this.ports.projection;
    const scope = recovery.scopeRef.scope;
    const current = scopes.getSnapshot(scope);
    const draft = mergeNewThreadRecoveryDraft(recovery.draft, current.draft);
    const attachments = mergeNewThreadRecoveryAttachments(recovery.attachments, current.attachments);
    // Keep edits made while the runtime was starting and place the failed
    // prompt before them, so neither text nor a newly selected image vanishes.
    if (draft !== current.draft) {
      scopes.setDraft(scope, draft);
      writeComposerDraft(storage, scope, draft);
    }
    if (attachments.length !== current.attachments.length) scopes.setAttachments(scope, attachments);
    // Draft scopes are persisted through the active-new-thread record. A late
    // detached failure can otherwise restore the textarea only until reload.
    if (typeof scope === "string" && scope.startsWith("new:")) {
      const pending = newThread.current();
      if (pending && draftKey(undefined, pending) === scope) {
        writeNewThreadDraft(storage, { ...pending, draft: draft || undefined });
      }
    }
  }

  private restoreFailed(recovery: NewThreadSubmissionRecovery, sessionId: string): void {
    const { scopes, storage, threads, newThread, view } = this.ports.projection;
    recovery.sessionId = sessionId || recovery.sessionId;
    const oldScope = recovery.scopeRef.scope;
    const visible = draftKey(view.getSnapshot()?.sessionId, newThread.current()) === oldScope
      || (recovery.sessionId !== undefined && threads.getSnapshot().activeThreadId === recovery.sessionId);
    let pending = newThread.current();

    // Once a positive user-message promoted the draft, a later failure must
    // reopen that same runtime-backed draft. Retrying it then uses sendPrompt
    // with the generated session id instead of allocating another runtime.
    if (visible && recovery.promoted
      && (!pending || pending.draftId !== recovery.pending.draftId)) {
      pending = { ...recovery.pending, ...(recovery.sessionId ? { sessionId: recovery.sessionId } : {}) };
      const target = createDraftKey(draftKey(undefined, pending));
      scopes.moveScope(oldScope, target);
      recovery.scopeRef.scope = target;
      newThread.set(pending);
      writeNewThreadDraft(storage, pending);
    } else if (visible && pending && pending.draftId === recovery.pending.draftId && recovery.sessionId && !pending.sessionId) {
      pending = { ...pending, sessionId: recovery.sessionId };
      newThread.set(pending);
      writeNewThreadDraft(storage, pending);
    }
    this.restoreSubmission(recovery);
  }
}

function retargetOptimisticByClientMessageId(view: ThreadViewStore, clientMessageId: string, nextScope: string): void {
  view.setOptimisticMessages((current) => current.map((entry) => (
    entry.message.clientMessageId === clientMessageId ? { ...entry, scope: nextScope } : entry
  )));
}

function removeOptimisticByClientMessageId(view: ThreadViewStore, clientMessageId: string): void {
  view.setOptimisticMessages((current) => current.filter((entry) => entry.message.clientMessageId !== clientMessageId));
}
