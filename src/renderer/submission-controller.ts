import type {
  NewThreadRequestId,
  PreparedPrompt,
  UiMessage,
  UiPromptAttachment,
  UiSkillDraft,
} from "../shared/contracts";
import type { HostActionResult, HostUpdate } from "../shared/host-protocol";
import { chosenNewThreadRuntime, effectiveNewThreadRuntime } from "./new-thread-runtime";
import { matchesTranscriptTurnMessage } from "../shared/transcript-turn";
import {
  isCurrentTranscriptSubmission,
  transcriptNavigationScope,
  transcriptNavigationScopeKey,
  type NewThreadSubmissionCompletion,
  type NewThreadSubmissionRecovery,
  type TranscriptSubmissionIdentity,
} from "../workbench/app-state";
import { allocateAttachmentId, createDraftKey, type ComposerScopeStore, type DraftKey } from "../workbench/composer-scope-store";
import type { ClientStorage } from "../workbench/client-storage";
import type { SubmitResult } from "./components/Composer";
import type { TranscriptTurnPort } from "../workbench/turn-scope";
import { draftKey, writeComposerDraft, writeNewThreadDraft, type NewThreadDraft } from "../workbench/draft-store";
import { errorMessage } from "../workbench/error-message";
import type { ExtensionRegistry, WorkbenchActions } from "./extension-system";
import type { HostClient } from "../workbench/host-client";
import type { HostSessionState } from "../workbench/host-session-state";
import type { NewThreadDeliveryPort } from "../workbench/new-thread-delivery";
import type { PreferencesStore } from "./preferences";
import type { ThreadStore } from "../workbench/thread-store";
import type { ThreadViewStore } from "../workbench/thread-view-store";
import {
  buildOptimisticMessage,
  addOptimisticMessage,
  removeOptimisticMessage,
  retargetOptimisticMessage,
} from "./submission-optimistic";
import { shouldQueueSubmission, formatQueuedFollowUp } from "./submission-queue";

/** One message leaving the composer, whatever it turns into. */
export interface SubmissionInput {
  text: string;
  attachments?: UiPromptAttachment[];
  /** Where the message goes; a plain prompt when absent. `alternate` is a plain prompt sent with the modifier held. */
  delivery?: "followUp" | "steer" | "alternate";
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
  storage: ClientStorage;
  preferences: PreferencesStore;
  notify(message?: string): void;
  actions(): WorkbenchActions | undefined;
  hostSession: HostSessionState;
  delivery: NewThreadDeliveryPort;
  newThread: NewThreadPort;
  turn: TranscriptTurnPort;
  host: HostUpdatePort;
  /** Parks the message in the host's queue for the thread; rejects when the host refused it. */
  enqueueFollowUp(threadId: string, item: { text: string; attachments: UiPromptAttachment[]; skillDraft?: UiSkillDraft }): Promise<void>;
}

/**
 * Everything that happens between the composer and the runtime: slash
 * commands, prepared prompts, optimistic rows, the transcript turn, the four
 * delivery paths and the recovery of a new thread's first message.
 */
export class SubmissionController {
  private turnSequence = 0;

  constructor(private readonly ports: SubmissionControllerPorts) {}

  /**
   * Runs the extensions' new-thread gates and moves the draft to the workspace
   * one of them names. A gate that fails or that the user left behind changes
   * nothing: the prompt goes to the project the draft already had.
   */
  /** The line a draft's transcript shows while an extension works on its first prompt. */
  private preparingNotice(pending: NewThreadDraft, scope: DraftKey): { preparing(message: string): void; clear(): void } {
    const { view } = this.ports;
    const noticeId = `local-preparing-${pending.draftId}`;
    return {
      preparing: (message) => {
        view.setOptimisticMessages((current) => [
          ...current.filter((entry) => entry.message.id !== noticeId),
          { scope, message: { id: noticeId, role: "notice", text: message, timestamp: Date.now() } },
        ]);
      },
      clear: () => view.setOptimisticMessages((current) => current.filter((entry) => entry.message.id !== noticeId)),
    };
  }

  /**
   * The runtime a draft's thread is created on and the model it starts with.
   * An unchanged model chip is still a choice: the shown Pi model is carried
   * into the new runtime instead of silently falling back to host defaults.
   */
  private newThreadStart(pending: NewThreadDraft) {
    const snapshot = this.ports.view.getSnapshot();
    const runtime = effectiveNewThreadRuntime(pending.runtime ?? this.ports.preferences.getSnapshot().newThreadRuntime, snapshot);
    const inherited = runtime === "pi" && (snapshot?.backendKind ?? "pi") === "pi" ? snapshot?.model : undefined;
    // What the draft chose goes to the runtime it was chosen from and no other.
    const chosen = (pending.selectionRuntime ?? "pi") === runtime;
    const model = (chosen ? pending.model : undefined) ?? inherited;
    const thinkingLevel = chosen ? pending.thinkingLevel : undefined;
    // A mode goes only to a runtime that offers it; a host that lists no runtimes decides itself.
    const backend = snapshot?.runtimeBackends?.find((entry) => entry.kind === runtime);
    const mode = pending.mode && (!backend || backend.modes?.includes(pending.mode)) ? pending.mode : undefined;
    return { runtime, model, ...(thinkingLevel ? { thinkingLevel } : {}), ...(mode ? { mode } : {}) };
  }

  /** Offers the first prompt to an extension that starts the thread itself; true when one took it. */
  private claimNewThread = async (pending: NewThreadDraft, prompt: string, alternate: boolean, attachments: UiPromptAttachment[], skillDraft?: UiSkillDraft): Promise<boolean> => {
    const actions = this.ports.actions();
    const scope = draftKey(undefined, pending);
    if (!actions || !scope) return false;
    const { runtime, model, thinkingLevel, mode } = this.newThreadStart(pending);
    const notice = this.preparingNotice(pending, scope);
    try {
      return await this.ports.registry.claimNewThread({
        prompt,
        projectPath: pending.projectPath,
        workspaceId: pending.workspaceId,
        preparing: notice.preparing,
        alternate,
        model,
        runtime,
        attachments: attachments.length,
        promptAttachments: attachments,
        skillDraft,
        thinkingLevel,
        mode,
      }, actions);
    } finally {
      notice.clear();
    }
  };

  private prepareNewThreadWorkspace = async (pending: NewThreadDraft, prompt: string): Promise<NewThreadDraft> => {
    const { registry, newThread } = this.ports;
    const actions = this.ports.actions();
    const scope = draftKey(undefined, pending);
    if (!actions || !scope) return pending;
    const { preparing, clear } = this.preparingNotice(pending, scope);
    try {
      const gate = await registry.prepareNewThread(
        { prompt, projectPath: pending.projectPath, ...(pending.workspaceId ? { workspaceId: pending.workspaceId } : {}), preparing },
        actions,
      );
      const moved = gate?.workspace;
      // The user may have left this draft while the gate worked.
      if (!moved || newThread.current()?.draftId !== pending.draftId) return pending;
      const next: NewThreadDraft = {
        ...pending,
        workspaceId: moved.workspaceId,
        projectPath: moved.displayPath,
        ...(moved.name ? { projectName: moved.name } : {}),
      };
      newThread.set(next);
      return next;
    } finally {
      clear();
    }
  };

  submit = async (input: SubmissionInput): Promise<SubmitResult> => {
    const { client: getClient, view, threads, scopes, registry, newThread, turn, host } = this.ports;
    const { skillDraft } = input;
    const alternate = input.delivery === "alternate";
    const delivery = input.delivery === "alternate" ? undefined : input.delivery;
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
    // Shell command execution: !cmd feeds output to LLM context, !!cmd runs silently
    if (commandText.startsWith("!") && attachments.length === 0 && !skillDraft) {
      const isExcluded = commandText.startsWith("!!");
      const shellCmd = isExcluded ? commandText.slice(2).trim() : commandText.slice(1).trim();
      if (shellCmd) {
        const actions = this.ports.actions();
        if (!actions) return { accepted: false, message: "The workbench is not ready yet." };
        try {
          const result = await actions.runShellAction(shellCmd, !isExcluded);
          if (result.cancelled) {
            this.ports.notify("Shell command cancelled.");
          } else if (result.exitCode !== undefined && result.exitCode !== 0) {
            this.ports.notify(`Shell command exited with code ${result.exitCode}`);
          }
          return { accepted: true };
        } catch (error) {
          return { accepted: false, message: errorMessage(error) };
        }
      }
    }
    const client = getClient();
    let pendingNewThread = newThread.current();
    try {
      if (pendingNewThread && !pendingNewThread.sessionId && await this.claimNewThread(pendingNewThread, text, alternate, attachments, skillDraft)) {
        return { accepted: true };
      }
    } catch (error) {
      return { accepted: false, message: errorMessage(error) };
    }
    const snapshot = view.getSnapshot();
    const visibleStreaming = threads.getActivity().isStreaming;
    // Enter during a run parks the message above the composer. It is prepared
    // and sent as a plain prompt once the thread settles, or steered on demand.
    if (shouldQueueSubmission({ isPendingNewThread: Boolean(pendingNewThread), hasSnapshot: Boolean(snapshot), visibleStreaming, delivery })) {
      try {
        await this.ports.enqueueFollowUp(snapshot!.sessionId, formatQueuedFollowUp(input.text, attachments, skillDraft));
      } catch (error) {
        return { accepted: false, message: errorMessage(error) };
      }
      return { accepted: true };
    }
    let prepared: PreparedPrompt | undefined;
    if (client) {
      try {
        prepared = await client.preparePrompt(
          text,
          pendingNewThread ? undefined : this.ports.hostSession.sessionIdFor(snapshot?.sessionId),
          skillDraft,
          pendingNewThread ? chosenNewThreadRuntime(pendingNewThread.runtime ?? this.ports.preferences.getSnapshot().newThreadRuntime, snapshot) : undefined,
        );
      } catch (error) {
        // ComposerScopeStore keeps the captured draft when a submission is
        // rejected, including edits made while preflight was in flight.
        // Re-seeding here would overwrite those newer edits.
        this.ports.notify(String(error));
        return { accepted: false, message: errorMessage(error) };
      }
    }
    // A draft may move to another project before its thread exists: this is
    // where Workspace Kit creates the worktree a new thread runs in (ADR 0017).
    if (pendingNewThread && !pendingNewThread.sessionId) {
      pendingNewThread = await this.prepareNewThreadWorkspace(pendingNewThread, text);
    }
    const newThreadRequestId = newThread.requestId();
    const {
      optimistic,
      clientTurn,
      logicalTurnId,
      clientMessageId,
      visiblePrompt,
    } = buildOptimisticMessage({
      text,
      attachments,
      skillDraft,
      prepared,
      sequence: this.turnSequence++,
      newThreadRequestId,
    });
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
      removeOptimisticMessage(view, optimistic.id);
      if (currentSubmission) this.ports.notify(String(error));
      return { accepted: false, message: errorMessage(error) };
    };
    const submittedDraftKey = draftKey(snapshot?.sessionId, pendingNewThread);
    const optimisticScope = submittedDraftKey ?? `session:${snapshot?.sessionId ?? "unknown"}`;
    if (!pendingNewThread && visibleStreaming) {
      addOptimisticMessage(view, optimisticScope, optimistic);
      startTranscriptTurn(snapshot?.sessionId);
      try {
        if (!client) throw new Error("Steering requires the Electron host.");
        await client.steer(text, attachments, this.ports.hostSession.sessionIdFor(snapshot?.sessionId), clientTurn, prepared);
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
          attachments: attachments.flatMap((attachment) => attachment.kind !== "image" ? [] : [{
            ...attachment,
            id: allocateAttachmentId(),
            previewUrl: `data:${attachment.mimeType};base64,${attachment.data}`,
          }]),
          optimistic,
          ipcPending: true,
        }
        : undefined;
      if (recovery) {
        // The user may have left this draft while the prompt was being prepared.
        if (newThread.current()?.draftId !== pending.draftId) recovery.detached = true;
        this.ports.delivery.register(clientMessageId, recovery);
      }
      startTranscriptTurn(pending.sessionId, false, true);
      addOptimisticMessage(view, optimisticScope, optimistic);
      try {
        if (!client) throw new Error("New thread requires the Electron host.");
        if (pending.sessionId) {
          if (pending.mode) await client.setMode(pending.mode, pending.sessionId);
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
        // The draft's project is named by identity; its path is only for display.
        // An unchanged model chip is still a choice. Carry the shown Pi model
        // into the new runtime instead of silently falling back to host defaults.
        const { model: requestedModel, thinkingLevel, mode } = this.newThreadStart(pending);
        // The host streams the new thread to this client from its first detail, before its id is known here.
        const releaseRequest = client.watchNewThread(newThreadRequestId);
        const result = await (requestedModel || thinkingLevel || mode
          ? client.newSession(
            text,
            attachments,
            pending.workspaceId ?? pending.projectPath,
            clientTurn,
            prepared,
            {
              ...(requestedModel ? { model: { provider: requestedModel.provider, id: requestedModel.id } } : {}),
              ...(thinkingLevel ? { thinkingLevel } : {}),
              ...(mode ? { mode } : {}),
            },
          )
          : client.newSession(text, attachments, pending.workspaceId ?? pending.projectPath, clientTurn, prepared)
        ).finally(releaseRequest);
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
            this.ports.delivery.rehomeDetached(clientMessageId, recovery, detachedSessionId);
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
          removeOptimisticMessage(view, optimistic.id);
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
          retargetOptimisticMessage(view, optimistic.id, `session:${sessionId}`);
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
        // A correlated user message may have promoted the draft before the call failed.
        if (recovery?.promoted) return { accepted: true };
        this.release(clientMessageId);
        return rejectSubmission(error);
      }
    }
    if (snapshot) {
      threads.markRead(snapshot.sessionId);
      this.ports.preferences.unsettle(snapshot.sessionId);
    }
    startTranscriptTurn(snapshot?.sessionId);
    addOptimisticMessage(view, optimisticScope, optimistic);
    if (!client) return this.deliverInPreview();
    try {
      await client.sendPrompt(text, attachments, this.ports.hostSession.sessionIdFor(snapshot?.sessionId), clientTurn, prepared);
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
  hasRecovery = (clientMessageId: string): boolean => this.ports.delivery.hasRecovery(clientMessageId);

  /** The composer scope a held delivery would restore into. */
  recoveryScope = (clientMessageId: string): string | undefined => this.ports.delivery.recoveryScope(clientMessageId);

  /** The host answered this prompt without persisting a user turn. */
  markWithoutUserTurn = (clientMessageId: string): void => {
    this.ports.delivery.markWithoutUserTurn(clientMessageId);
  };

  /** A host-reported thread is correlated and promoted by the shared coordinator. */
  promoteReportedThread = (sessionId: string, message: UiMessage, requestId?: NewThreadRequestId): boolean =>
    this.ports.delivery.promoteReportedThread(sessionId, message, requestId);

  /** Commit a new-thread delivery without changing whichever thread is visible. */
  promoteRecovery = (clientMessageId: string, sessionId: string, message?: UiMessage): boolean =>
    this.ports.delivery.promoteRecovery(clientMessageId, sessionId, message);

  /** The host's own verdict on a delivery, whichever thread is on screen. */
  settleDelivery = (
    clientMessageId: string,
    sessionId: string,
    settlement: { accepted: true } | { accepted: false; message: string },
  ): boolean => this.ports.delivery.settleDelivery(clientMessageId, sessionId, settlement);

  /** Leaving a draft lets the shared coordinator continue delivery in the background. */
  detachPendingDelivery = (): boolean => this.ports.delivery.detachPendingDelivery();

  /** The navigation scope as of now; a submission compares against it after every await. */
  private currentScopeKey(): string {
    return transcriptNavigationScopeKey(this.ports.view.getSnapshot(), this.ports.newThread.current());
  }

  private release(clientMessageId: string): void {
    this.ports.delivery.release(clientMessageId);
  }

  private settleIpc(clientMessageId: string, recovery?: NewThreadSubmissionRecovery): void {
    this.ports.delivery.markIpcSettled(clientMessageId, recovery);
  }

  /** Close a new-thread submission that the visible draft is still waiting on. */
  private complete(completion: NewThreadSubmissionCompletion): void {
    const { view, threads, scopes, storage, newThread, host } = this.ports;
    const { pending, sessionId, optimisticId, prompt, scope, requestId, result, recovery } = completion;
    if (!newThread.isCurrent(pending, scope, requestId)) return;
    retargetOptimisticMessage(view, optimisticId, `session:${sessionId}`);
    if (pending.model) {
      // The first detail is intentionally published before the slow catalog.
      // Keep the explicit choice visible during that gap; the later catalog
      // remains authoritative and may replace it if the runtime reports one.
      view.setSnapshot((current) => current ? {
        ...current,
        cwd: pending.projectPath,
        sessionId,
        model: pending.model,
      } : current);
    }
    if (scope) scopes.moveScope(createDraftKey(scope), createDraftKey(draftKey(sessionId)));
    writeNewThreadDraft(storage);
    newThread.set(undefined);
    if (result) host.applyHostResult(result);
    threads.markRead(sessionId);
    this.ports.delivery.notifyPromptSubmitted(pending, sessionId, prompt, recovery);
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
