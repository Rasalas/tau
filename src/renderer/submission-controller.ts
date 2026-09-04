import type {
  ClientTurnIdentity,
  NewThreadRequestId,
  PreparedPrompt,
  UiMessage,
  UiPromptAttachment,
  UiSkillDraft,
} from "../shared/contracts";
import type { HostActionResult, HostUpdate } from "../shared/host-protocol";
import { matchesTranscriptTurnMessage } from "../shared/transcript-turn";
import {
  backgroundNewThreadDetail,
  createClientMessageId,
  isCurrentTranscriptSubmission,
  isSameUserMessage,
  mergeNewThreadRecoveryAttachments,
  mergeNewThreadRecoveryDraft,
  skillPresentationForDraft,
  transcriptNavigationScope,
  transcriptNavigationScopeKey,
  type NewThreadSubmissionCompletion,
  type NewThreadSubmissionRecovery,
  type TranscriptSubmissionIdentity,
} from "./app-state";
import { allocateAttachmentId, createDraftKey, type ComposerScopeStore, type DraftKey } from "./composer-scope-store";
import type { SubmitResult } from "./components/Composer";
import type { TranscriptTurnStart } from "./components/transcript-navigation";
import { draftKey, writeComposerDraft, writeNewThreadDraft, type NewThreadDraft } from "./draft-store";
import { errorMessage } from "./error-message";
import type { ExtensionRegistry, WorkbenchActions } from "./extension-system";
import type { HostClient } from "./host-client";
import { preferences } from "./preferences";
import type { ThreadStore } from "./thread-store";
import type { ThreadViewStore } from "./thread-view-store";

/** One message leaving the composer, whatever it turns into. */
export interface SubmissionInput {
  text: string;
  attachments?: UiPromptAttachment[];
  /** Where the message goes; a plain prompt when absent. */
  delivery?: "followUp" | "steer";
  skillDraft?: UiSkillDraft;
}

/** The unstarted thread a draft stands for, owned by the new-thread controller. */
export interface NewThreadPort {
  current(): NewThreadDraft | undefined;
  set(draft: NewThreadDraft | undefined): void;
  update(change: (current: NewThreadDraft | undefined) => NewThreadDraft | undefined): void;
  requestId(): NewThreadRequestId;
  isCurrent(pending: NewThreadDraft, scope: DraftKey | undefined, requestId: NewThreadRequestId): boolean;
  markAwaitingPromotion(context: { pending: NewThreadDraft; scope: DraftKey | undefined; requestId: NewThreadRequestId }): boolean;
  promoteFromUserMessage(sessionId: string, projectPath: string): DraftKey | undefined;
}

/** Where the transcript starts reading this turn; the workbench renders it. */
export interface TranscriptTurnPort {
  current(): TranscriptTurnStart | undefined;
  set(next: TranscriptTurnStart | undefined, expectedTurnId?: string): boolean;
}

/** What the host says back, applied by the workbench's update path. */
export interface HostUpdatePort {
  applyHostUpdate(update: HostUpdate): void;
  applyActionResult(result: HostActionResult): boolean;
  applyHostResult(result: HostActionResult, inheritDraft?: boolean): void;
  /** Announces a correlated thread transition before its detail is applied. */
  prepareThreadDetail(sessionId: string): boolean;
}

export interface SubmissionControllerPorts {
  client(): HostClient | undefined;
  view: ThreadViewStore;
  threads: ThreadStore;
  scopes: ComposerScopeStore;
  registry: ExtensionRegistry;
  storage: Storage;
  notify(message?: string): void;
  actions(): WorkbenchActions | undefined;
  newThread: NewThreadPort;
  turn: TranscriptTurnPort;
  host: HostUpdatePort;
  enqueueFollowUp(threadId: string, item: { text: string; attachments: UiPromptAttachment[]; skillDraft?: UiSkillDraft }): void;
  /** A held or released delivery changes what the workbench may do next. */
  onRecoveriesChanged(): void;
}

/**
 * Everything that happens between the composer and the runtime: slash
 * commands, prepared prompts, optimistic rows, the transcript turn, the four
 * delivery paths and the recovery of a new thread's first message.
 */
export class SubmissionController {
  /** Detached and in-flight new-thread deliveries, keyed by client message id. */
  private readonly recoveries = new Map<string, NewThreadSubmissionRecovery>();
  private turnSequence = 0;
  private hostSnapshotApplied = false;

  constructor(private readonly ports: SubmissionControllerPorts) {}

  /**
   * The host has published a thread for this run. Until it does, the rendered
   * snapshot may still be the bootstrap cache's, whose session id names a
   * thread this host has never opened.
   */
  notifyHostSnapshot = (): void => { this.hostSnapshotApplied = true; };

  submit = async (input: SubmissionInput): Promise<SubmitResult> => {
    const { client: getClient, view, threads, scopes, registry, newThread, turn, host } = this.ports;
    const { skillDraft, delivery } = input;
    const attachments = input.attachments ?? [];
    const text = skillDraft ? input.text : input.text.trim();
    const commandText = text.trim();
    if (!commandText && attachments.length === 0) return { accepted: false, message: "Enter a message or attach an image." };
    // Desktop extensions own slash commands the runtime never sees.
    const slash = attachments.length === 0 && !skillDraft ? registry.findSlashCommand(commandText) : undefined;
    if (slash) {
      const actions = this.ports.actions();
      if (!actions) return { accepted: false, message: "The workbench is not ready yet." };
      try {
        const message = await slash.command.run(slash.args, actions);
        return message ? { accepted: false, message } : { accepted: true };
      } catch (error) {
        return { accepted: false, message: errorMessage(error) };
      }
    }
    const client = getClient();
    const pendingNewThread = newThread.current();
    const snapshot = view.getSnapshot();
    const visibleStreaming = threads.getActivity().isStreaming;
    // Enter during a run parks the message above the composer. It is prepared
    // and sent as a plain prompt once the thread settles, or steered on demand.
    if (!pendingNewThread && snapshot && visibleStreaming && delivery !== "steer") {
      this.ports.enqueueFollowUp(snapshot.sessionId, { text: input.text, attachments, ...(skillDraft ? { skillDraft } : {}) });
      return { accepted: true };
    }
    let prepared: PreparedPrompt | undefined;
    if (client) {
      try {
        prepared = await client.preparePrompt(
          text,
          pendingNewThread ? undefined : this.hostSessionId(snapshot?.sessionId),
          skillDraft,
        );
      } catch (error) {
        // ComposerScopeStore keeps the captured draft when a submission is
        // rejected, including edits made while preflight was in flight.
        // Re-seeding here would overwrite those newer edits.
        this.ports.notify(String(error));
        return { accepted: false, message: errorMessage(error) };
      }
    }
    const optimisticText = prepared?.visibleText
      ?? skillDraft?.visibleText
      ?? (text || `Attached ${attachments.map((attachment) => attachment.name).join(", ")}`);
    const visiblePrompt = prepared?.visibleText ?? skillDraft?.visibleText ?? text;
    const optimisticSkill = prepared
      ? prepared.skill
      : skillDraft ? skillPresentationForDraft(skillDraft) : undefined;
    const submittedAt = Date.now();
    const logicalTurnId = `turn-${submittedAt}-${this.turnSequence++}`;
    const clientMessageId = createClientMessageId();
    const optimistic: UiMessage = {
      id: `local-${clientMessageId}`,
      clientTurnId: logicalTurnId,
      clientMessageId,
      role: "user",
      text: optimisticText,
      ...(optimisticSkill ? { skill: optimisticSkill } : {}),
      images: attachments.map(({ mimeType, data }) => ({ mimeType, data })),
      timestamp: submittedAt,
    };
    const newThreadRequestId = newThread.requestId();
    const clientTurn: ClientTurnIdentity = {
      clientTurnId: logicalTurnId,
      clientMessageId,
      ...(newThreadRequestId ? { newThreadRequestId } : {}),
    };
    const submissionScopeKey = transcriptNavigationScopeKey(snapshot, pendingNewThread);
    const submissionScope = transcriptNavigationScope(snapshot, pendingNewThread);
    const submissionIdentity: TranscriptSubmissionIdentity = {
      turnId: logicalTurnId,
      scopeKey: submissionScopeKey,
      scope: submissionScope,
      draftId: pendingNewThread?.draftId,
    };
    const isCurrentSubmission = () => isCurrentTranscriptSubmission(
      turn.current(),
      this.currentScopeKey(),
      newThread.current()?.draftId,
      submissionIdentity,
    );
    const startTranscriptTurn = (
      targetSessionId?: string,
      awaitingMessage = false,
      preserveAcrossSessionChange = false,
    ) => {
      turn.set({
        turnId: logicalTurnId,
        scope: submissionScope,
        sessionId: targetSessionId,
        messageId: awaitingMessage ? undefined : optimistic.id,
        clientMessageId: clientTurn.clientMessageId,
        text: optimistic.text,
        timestamp: optimistic.timestamp,
        awaitingMessage,
        preserveAcrossSessionChange,
        scopeKey: submissionScopeKey,
      });
    };
    const cancelTranscriptTurn = () => { turn.set(undefined, logicalTurnId); };
    /** Undo the optimistic row and the turn when a delivery never reached the runtime. */
    const rejectSubmission = (error: unknown): SubmitResult => {
      const currentSubmission = isCurrentSubmission();
      cancelTranscriptTurn();
      view.setOptimisticMessages((current) => current.filter((entry) => entry.message.id !== optimistic.id));
      if (currentSubmission) this.ports.notify(String(error));
      return { accepted: false, message: errorMessage(error) };
    };
    const submittedDraftKey = draftKey(snapshot?.sessionId, pendingNewThread);
    const optimisticScope = submittedDraftKey ?? `session:${snapshot?.sessionId ?? "unknown"}`;
    if (!pendingNewThread && visibleStreaming) {
      view.setOptimisticMessages((current) => [...current, { scope: optimisticScope, message: optimistic }]);
      startTranscriptTurn(snapshot?.sessionId);
      try {
        if (!client) throw new Error("Steering requires the Electron host.");
        await client.steer(text, attachments, this.hostSessionId(snapshot?.sessionId), clientTurn, prepared);
      } catch (error) {
        return rejectSubmission(error);
      }
      return { accepted: true };
    }
    if (pendingNewThread) {
      const pending = pendingNewThread;
      const pendingKey = draftKey(undefined, pending);
      const findPersistedPrompt = (created?: HostUpdate) => created?.type === "thread-detail"
        ? created.detail.messages.find((message) => matchesTranscriptTurnMessage(message, {
          turnId: clientTurn.clientTurnId,
          clientMessageId: clientTurn.clientMessageId,
          messageId: optimistic.id,
          text: optimistic.text,
          timestamp: optimistic.timestamp,
        }))
        : undefined;
      const recovery: NewThreadSubmissionRecovery | undefined = submittedDraftKey
        ? {
          pending,
          requestId: newThreadRequestId,
          scopeRef: scopes.createScopeReference(submittedDraftKey),
          draft: text,
          attachments: attachments.map((attachment) => ({
            ...attachment,
            id: allocateAttachmentId(),
            previewUrl: `data:${attachment.mimeType};base64,${attachment.data}`,
          })),
          optimistic,
          ipcPending: true,
        }
        : undefined;
      if (recovery) {
        // The user may have left this draft while the prompt was being prepared.
        if (newThread.current()?.draftId !== pending.draftId) recovery.detached = true;
        this.recoveries.set(clientMessageId, recovery);
        this.ports.onRecoveriesChanged();
      }
      startTranscriptTurn(pending.sessionId, false, true);
      view.setOptimisticMessages((current) => [...current, { scope: optimisticScope, message: optimistic }]);
      try {
        if (!client) throw new Error("New thread requires the Electron host.");
        if (pending.sessionId) {
          await client.sendPrompt(text, attachments, pending.sessionId, clientTurn, prepared);
          this.settleIpc(clientMessageId, recovery);
          if (recovery?.failed) {
            this.release(clientMessageId);
            return { accepted: false, message: recovery.failed };
          }
          // Unlike newSession, this call resolves at the runtime's own delivery
          // acceptance, so returning from it is the commit. A correlated user
          // message may have committed it first; then there is nothing to do.
          if (recovery?.detached && !recovery.promoted) {
            this.promoteRecovery(clientMessageId, pending.sessionId, recovery.withoutUserTurn ? undefined : recovery.optimistic);
          } else if (!recovery?.promoted) {
            this.complete({ pending, sessionId: pending.sessionId, optimisticId: optimistic.id, prompt: visiblePrompt, scope: submittedDraftKey, requestId: newThreadRequestId, recovery });
          }
          this.release(clientMessageId);
          return { accepted: true };
        }
        const result = await client.newSession(text, attachments, pending.projectPath, clientTurn, prepared);
        this.settleIpc(clientMessageId, recovery);
        if (recovery?.failed) {
          this.release(clientMessageId);
          return { accepted: false, message: recovery.failed };
        }
        // A session id is only the runtime binding, never the delivery commit.
        // Record it so a late failure retries in this session instead of
        // allocating a second runtime.
        if (recovery && result.sessionId) recovery.sessionId = result.sessionId;
        // A correlated user message may have promoted the draft while the
        // newSession IPC call was still pending. Its scope and active thread
        // are already correct, but the result still carries authoritative
        // shell, detail, catalog and project updates that must not be dropped.
        // They pass through the normal race guard rather than being forced.
        if (recovery?.promoted && result.submission.accepted) {
          result.updates.forEach((update) => host.applyHostUpdate(update));
          return { accepted: true };
        }
        if (recovery?.detached) {
          const createdDetail = result.updates.find((update) => update.type === "thread-detail");
          const detachedSessionId = result.sessionId ?? (createdDetail?.type === "thread-detail" ? createdDetail.detail.sessionId : undefined);
          if (!result.submission.accepted) {
            this.release(clientMessageId);
            return result.submission;
          }
          if (detachedSessionId && recovery.sessionId !== detachedSessionId) {
            this.rehomeDetached(clientMessageId, recovery, detachedSessionId);
          }
          // The user is looking at something else now; only the thread list
          // learns about the new thread.
          result.updates.forEach((update) => {
            if (update.type === "thread-index" || update.type === "thread-shell") host.applyHostUpdate(update);
          });
          const persistedPrompt = findPersistedPrompt(createdDetail);
          if (persistedPrompt && detachedSessionId) this.promoteRecovery(clientMessageId, detachedSessionId, persistedPrompt);
          return { accepted: true };
        }
        if (!newThread.isCurrent(pending, submittedDraftKey, newThreadRequestId)) {
          this.release(clientMessageId);
          return result.submission;
        }
        const created = result.updates.find((update) => update.type === "thread-detail");
        if (result.submission.accepted
          && created?.type !== "thread-detail"
          && result.requestId === newThreadRequestId) {
          newThread.markAwaitingPromotion({ pending, scope: submittedDraftKey, requestId: newThreadRequestId });
        }
        host.applyActionResult(result);
        if (!result.submission.accepted) {
          const rejectedDetail = result.updates.find((update) => update.type === "thread-detail");
          const sessionId = rejectedDetail?.type === "thread-detail" ? rejectedDetail.detail.sessionId : undefined;
          if (sessionId) {
            if (newThread.isCurrent(pending, submittedDraftKey, newThreadRequestId)) {
              newThread.update((current) => current ? { ...current, sessionId } : current);
              writeNewThreadDraft(this.ports.storage, { ...pending, sessionId });
            }
          }
          view.setOptimisticMessages((current) => current.filter((entry) => entry.message.id !== optimistic.id));
          this.release(clientMessageId);
          return result.submission;
        }
        const sessionId = created?.type === "thread-detail" ? created.detail.sessionId : undefined;
        if (turn.current()?.turnId !== logicalTurnId
          || this.currentScopeKey() !== submissionScopeKey
          || newThread.current()?.draftId !== pending.draftId) {
          // The draft was abandoned while the host was creating its session.
          // Do not let a late result switch the newly selected thread back.
          writeComposerDraft(this.ports.storage, pendingKey, "");
          this.release(clientMessageId);
          return result.submission;
        }
        if (sessionId) {
          if (recovery) recovery.sessionId = sessionId;
          // The optimistic message moves to the real thread before the draft
          // view closes, so nothing flickers while the host confirms it.
          view.setOptimisticMessages((current) => current.map((entry) => entry.message.id === optimistic.id
            ? { ...entry, scope: `session:${sessionId}` }
            : entry));
          const persistedPrompt = findPersistedPrompt(created);
          const currentTurn = turn.current();
          if (currentTurn?.turnId === logicalTurnId) {
            turn.set({
              ...currentTurn,
              sessionId,
              scope: { kind: "session" as const, projectPath: pending.projectPath, sessionId },
              messageId: persistedPrompt?.id ?? currentTurn.messageId,
              scopeKey: transcriptNavigationScopeKey({ cwd: pending.projectPath, sessionId }),
            }, logicalTurnId);
          }
          if (recovery) {
            // Delivery is detached from this acknowledgement. A prompt already
            // persisted in the result is itself the commit; otherwise the
            // host's settlement event completes the submission.
            if (persistedPrompt) this.promoteRecovery(clientMessageId, sessionId, persistedPrompt);
            return { accepted: true };
          }
          this.complete({ pending, sessionId, optimisticId: optimistic.id, prompt: visiblePrompt, scope: submittedDraftKey, requestId: newThreadRequestId, result });
          return { accepted: true };
        }
        // Pi's own TUI creates the thread and reports it later; the draft
        // view stays until that report arrives.
        return { accepted: true };
      } catch (error) {
        this.release(clientMessageId);
        return rejectSubmission(error);
      }
    }
    if (snapshot) {
      threads.markRead(snapshot.sessionId);
      preferences.unsettle(snapshot.sessionId);
    }
    startTranscriptTurn(snapshot?.sessionId);
    view.setOptimisticMessages((current) => [...current, { scope: optimisticScope, message: optimistic }]);
    if (!client) return this.deliverInPreview();
    try {
      await client.sendPrompt(text, attachments, this.hostSessionId(snapshot?.sessionId), clientTurn, prepared);
      const actions = this.ports.actions();
      if (actions) {
        void registry.notifyPromptSubmitted({ prompt: visiblePrompt, snapshot }, actions)
          .catch((error) => this.ports.notify(errorMessage(error)));
      }
      return { accepted: true };
    } catch (error) {
      return rejectSubmission(error);
    }
  };

  /** Whether a new-thread delivery still holds this client message. */
  hasRecovery = (clientMessageId: string): boolean => this.recoveries.has(clientMessageId);

  /** The composer scope a held delivery would restore into. */
  recoveryScope = (clientMessageId: string): string | undefined => this.recoveries.get(clientMessageId)?.scopeRef.scope;

  /** The host answered this prompt without persisting a user turn. */
  markWithoutUserTurn = (clientMessageId: string): void => {
    const recovery = this.recoveries.get(clientMessageId);
    if (recovery) recovery.withoutUserTurn = true;
  };

  /**
   * A host-reported thread carries either identity of a detached delivery: the
   * persisted client message, or the new-thread request it belongs to.
   */
  promoteReportedThread = (sessionId: string, message: UiMessage, requestId?: NewThreadRequestId): boolean => {
    const byRequest = requestId
      ? [...this.recoveries.entries()].find(([, recovery]) => recovery.requestId === requestId)?.[0]
      : undefined;
    const reported = message.clientMessageId;
    const clientMessageId = reported !== undefined && this.recoveries.has(reported) ? reported : byRequest;
    return clientMessageId ? this.promoteRecovery(clientMessageId, sessionId, message) : false;
  };

  /** Commit a new-thread delivery without changing whichever thread is now visible. */
  promoteRecovery = (clientMessageId: string, sessionId: string, message?: UiMessage): boolean => {
    const { view, threads, scopes, newThread, turn, host } = this.ports;
    const recovery = this.recoveries.get(clientMessageId);
    if (!recovery || recovery.failed) return false;
    if (recovery.sessionId && recovery.sessionId !== sessionId) return false;
    const keepInBackground = recovery.detached && threads.getSnapshot().activeThreadId !== sessionId;
    // A detached delivery must not reclaim the visible new-thread controller.
    const promotedScope = recovery.detached ? undefined : newThread.promoteFromUserMessage(sessionId, recovery.pending.projectPath);
    if (!promotedScope && !recovery.detached && recovery.sessionId !== sessionId) return false;
    recovery.sessionId = sessionId;
    recovery.promoted = true;
    scopes.moveScope(recovery.scopeRef.scope, createDraftKey(draftKey(sessionId)));
    view.setOptimisticMessages((current) => message
      ? current.map((entry) => entry.message.clientMessageId === clientMessageId
        ? { ...entry, scope: `session:${sessionId}` }
        : entry)
      : current.filter((entry) => entry.message.clientMessageId !== clientMessageId));

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
      // A blank detail may have arrived before this event. Feed the confirmed
      // message through the normal detail path so the history coordinator and
      // the active snapshot move together even when no catalog is available.
      host.prepareThreadDetail(sessionId);
      host.applyHostUpdate({
        version: 1,
        type: "thread-detail",
        detail: { sessionId, messages: [message], isStreaming: true, activeTools: [] },
      });
    } else {
      threads.setActiveThread(sessionId, true);
    }
    this.notifyPromptSubmitted(recovery.pending, sessionId, message?.text || recovery.draft, recovery);
    // Delivery acceptance is the commit point. The later IPC acknowledgement
    // must not keep thread navigation blocked and is safe because this record
    // is already promoted before the result can arrive.
    this.release(clientMessageId);
    return true;
  };

  /** The host's own verdict on a delivery, whichever thread is on screen. */
  settleDelivery = (
    clientMessageId: string,
    sessionId: string,
    settlement: { accepted: true } | { accepted: false; message: string },
  ): boolean => {
    const recovery = this.recoveries.get(clientMessageId);
    if (!recovery) return false;
    if (settlement.accepted) {
      const promoted = this.promoteRecovery(
        clientMessageId,
        sessionId,
        recovery.withoutUserTurn ? undefined : recovery.optimistic,
      );
      // The host has committed this delivery. Whether the draft was still there
      // to promote decides nothing: holding the record would block thread
      // switching and every guarded workspace action for the rest of the session.
      if (!promoted) this.release(clientMessageId);
      return true;
    }
    recovery.failed = settlement.message || "The runtime rejected the message.";
    this.restoreFailed(recovery, sessionId);
    // A failed delivery is safe to release once its IPC acknowledgement has
    // arrived; until then the late accepted result must not clear recovery.
    if (!recovery.ipcPending) this.release(clientMessageId);
    return true;
  };

  /**
   * Leaving a draft never waits for its first message: delivery continues in
   * the background and follows the runtime thread once the host has named one.
   */
  detachPendingDelivery = (): boolean => {
    const pending = this.ports.newThread.current();
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

  /**
   * The thread id a host call may name. An id restored from the bootstrap
   * cache belongs to the previous run; passing undefined instead means "the
   * thread the host has open", which is what a cold start needs.
   */
  private hostSessionId(sessionId?: string): string | undefined {
    return this.hostSnapshotApplied ? sessionId : undefined;
  }

  /** The navigation scope as of now; a submission compares against it after every await. */
  private currentScopeKey(): string {
    return transcriptNavigationScopeKey(this.ports.view.getSnapshot(), this.ports.newThread.current());
  }

  /** Bind a detached delivery to its runtime thread once the host names it. */
  private rehomeDetached(clientMessageId: string, recovery: NewThreadSubmissionRecovery, sessionId: string): void {
    recovery.sessionId = sessionId;
    this.ports.scopes.moveScope(recovery.scopeRef.scope, createDraftKey(draftKey(sessionId)));
    this.ports.view.setOptimisticMessages((current) => current.map((entry) => entry.message.clientMessageId === clientMessageId
      ? { ...entry, scope: `session:${sessionId}` } : entry));
  }

  private release(clientMessageId: string): void {
    const recovery = this.recoveries.get(clientMessageId);
    if (!recovery) return;
    this.recoveries.delete(clientMessageId);
    this.ports.scopes.releaseScopeReference(recovery.scopeRef);
    this.ports.onRecoveriesChanged();
  }

  private settleIpc(clientMessageId: string, recovery?: NewThreadSubmissionRecovery): void {
    const current = recovery ?? this.recoveries.get(clientMessageId);
    if (current) current.ipcPending = false;
  }

  /** Put a rejected prompt back into the composer it came from. */
  private restoreSubmission(recovery: NewThreadSubmissionRecovery): void {
    const { scopes, storage, newThread } = this.ports;
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
    const { scopes, storage, threads, newThread } = this.ports;
    recovery.sessionId = sessionId || recovery.sessionId;
    const oldScope = recovery.scopeRef.scope;
    const visible = draftKey(this.ports.view.getSnapshot()?.sessionId, newThread.current()) === oldScope
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

  /** Close a new-thread submission that the visible draft is still waiting on. */
  private complete(completion: NewThreadSubmissionCompletion): void {
    const { view, threads, scopes, storage, newThread, host } = this.ports;
    const { pending, sessionId, optimisticId, prompt, scope, requestId, result, recovery } = completion;
    if (!newThread.isCurrent(pending, scope, requestId)) return;
    view.setOptimisticMessages((current) => current.map((entry) => entry.message.id === optimisticId
      ? { ...entry, scope: `session:${sessionId}` }
      : entry));
    if (scope) scopes.moveScope(createDraftKey(scope), createDraftKey(draftKey(sessionId)));
    writeNewThreadDraft(storage);
    newThread.set(undefined);
    if (result) host.applyHostResult(result);
    threads.markRead(sessionId);
    this.notifyPromptSubmitted(pending, sessionId, prompt, recovery);
  }

  private notifyPromptSubmitted(
    pending: NewThreadDraft,
    sessionId: string,
    prompt: string,
    recovery?: NewThreadSubmissionRecovery,
  ): void {
    if (recovery?.notified) return;
    const actions = this.ports.actions();
    if (!actions) return;
    if (recovery) recovery.notified = true;
    const snapshot = this.ports.view.getSnapshot();
    void this.ports.registry.notifyPromptSubmitted({
      prompt,
      snapshot: snapshot ? {
        ...snapshot,
        cwd: pending.projectPath,
        sessionId,
        sessionName: undefined,
        sessionTitle: "Untitled thread",
        messages: [],
        isStreaming: false,
        activeTools: [],
        turnActivity: undefined,
        taskProgress: undefined,
        taskHistory: [],
      } : undefined,
    }, actions).catch((error) => this.ports.notify(errorMessage(error)));
  }

  /** Without the Electron host the workbench answers its own prompt. */
  private deliverInPreview(): SubmitResult {
    const { view, threads } = this.ports;
    const previewThreadId = view.getSnapshot()?.sessionId ?? "";
    threads.setThreadRunning(previewThreadId, true);
    window.setTimeout(() => {
      view.appendMessage({
        id: `mock-${Date.now()}`,
        role: "assistant",
        text: "Preview mode received the prompt. Launch `npm start` to send it through the real Pi SDK.",
        timestamp: Date.now(),
      });
      threads.setThreadRunning(previewThreadId, false);
    }, 650);
    return { accepted: true };
  }
}
