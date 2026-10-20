import type {
  NewThreadRequestId,
  ClientTurnIdentity,
  HostSnapshot,
  SubmissionResult,
  UiModel,
  ThreadBackendKind,
  PreparedPrompt,
  UiMessage,
  UiPromptAttachment,
  UiSkillDraft,
} from "../shared/contracts";
import type { HostActionResult, HostUpdate } from "../shared/host-protocol";
import { matchesTranscriptTurnMessage } from "../shared/transcript-turn";
import { skillFields } from "../shared/prepared-prompt";
import { isConnectionDropped } from "../shared/connection-dropped-error";
import {
  isCurrentTranscriptSubmission,
  mergeNewThreadRecoveryAttachments,
  mergeNewThreadRecoveryDraft,
  transcriptNavigationScope,
  transcriptNavigationScopeKey,
  type NewThreadSubmissionCompletion,
  type NewThreadSubmissionRecovery,
  type TranscriptSubmissionIdentity,
  type OptimisticUserMessage,
} from "./app-state";
import { allocateAttachmentId, createDraftKey, type ComposerScopeStore, type DraftKey } from "./composer-scope-store";
import type { ClientStorage } from "./client-storage";
import type { TranscriptTurnPort } from "./turn-scope";
import { draftKey, writeComposerDraft, writeNewThreadDraft, type NewThreadDraft } from "./draft-store";
import { errorMessage } from "./error-message";
import type { HostClient } from "./host-client";
import type { HostSessionState } from "./host-session-state";
import type { NewThreadDeliveryPort } from "./new-thread-delivery";
import type { ThreadStore } from "./thread-store";
import { SEND_FAILED_NOTICE, type ThreadViewStore } from "./thread-view-store";
import type { DraftThreads } from "./draft-threads";
import type { NewThreadController } from "./new-thread-controller";
import {
  buildOptimisticMessage,
  removeOptimisticMessage,
  retargetOptimisticMessage,
} from "./submission-optimistic";
import { shouldQueueSubmission, formatQueuedFollowUp, type SubmitDelivery } from "./submission-queue";

/** One message leaving the composer, whatever it turns into. */
export interface SubmissionInput {
  text: string;
  attachments?: UiPromptAttachment[];
  /**
   * Where the message goes; a plain prompt when absent. `alternate` is a plain
   * prompt sent with the modifier held; `{ deliverAt }` plans it into the queue.
   */
  delivery?: SubmitDelivery;
  skillDraft?: UiSkillDraft;
  /** The thread the message was meant for when it is not the one on screen by the time it is sent. */
  threadId?: string;
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

/** Renderer contributions; no session state or mutable stores cross this seam. */
export interface SubmissionEnvironment {
  command(text: string): (() => Promise<SubmissionResult>) | undefined;
  claimNewThread(event: SubmissionClaimEvent): Promise<boolean>;
  prepareNewThread(event: SubmissionPreparationEvent): Promise<{ workspace?: { workspaceId: string; displayPath: string; name?: string }; stop?: string } | undefined>;
  accepted(): void;
  submitted(event: { prompt: string; snapshot?: HostSnapshot }): Promise<void>;
  selection(pending: NewThreadDraft, snapshot: HostSnapshot | undefined): { runtime: ThreadBackendKind; requestedRuntime?: ThreadBackendKind; model?: UiModel; thinkingLevel?: string; mode?: string };
  unsettle(sessionId: string): void;
  preview(reply: () => void): void;
}

export interface SubmissionPreparationEvent {
  prompt: string;
  projectPath: string;
  workspaceId?: string;
  preparing(message: string): void;
}

export interface SubmissionClaimEvent extends SubmissionPreparationEvent {
  alternate: boolean;
  runtime: string;
  model?: { provider: string; id: string };
  thinkingLevel?: string;
  mode?: string;
  attachments: number;
  promptAttachments?: readonly UiPromptAttachment[];
  skillDraft?: UiSkillDraft;
}

/** Internal construction graph, assembled only by WorkbenchSession. */
export interface SubmissionControllerPorts {
  client(): HostClient | undefined;
  view: ThreadViewStore;
  threads: ThreadStore;
  scopes: ComposerScopeStore;
  environment: SubmissionEnvironment;
  storage: ClientStorage;
  notify(message?: string, level?: "info" | "warning" | "error", id?: string): void;
  hostSession: HostSessionState;
  delivery: NewThreadDeliveryPort;
  newThread: NewThreadPort;
  /** The draft rows; told when an extension started the draft's thread and the draft stays on screen. */
  drafts: Pick<DraftThreads, "startedElsewhere">;
  turn: TranscriptTurnPort;
  host: HostUpdatePort;
  /** Parks the message in the host's queue for the thread; rejects when the host refused it. */
  enqueueFollowUp(threadId: string, item: { text: string; attachments: UiPromptAttachment[]; skillDraft?: UiSkillDraft; deliverAt?: number; identity?: ClientTurnIdentity }): Promise<void>;
}

/** The adapters for delivery load with the controller, after the first send. */
export function createSubmissionController(ports: Omit<SubmissionControllerPorts, "newThread" | "enqueueFollowUp"> & { newThread: NewThreadController }): SubmissionController {
  const { newThread } = ports;
  return new SubmissionController({
    ...ports,
    newThread: {
      current: newThread.current, set: newThread.set,
      update: (change) => newThread.set(change),
      requestId: newThread.requestId, isCurrent: newThread.isCurrent,
      markAwaitingPromotion: newThread.markAwaitingPromotion,
      promoteFromUserMessage: newThread.promoteFromUserMessage,
    },
    enqueueFollowUp: async (threadId, item) => {
      const client = ports.client();
      if (!client) throw new Error("Queued messages need a connection to the machine.");
      if (item.identity) await client.queueMessage(threadId, item.text, item.attachments, item.skillDraft, item.deliverAt, item.identity);
      else if (item.deliverAt === undefined) await client.queueMessage(threadId, item.text, item.attachments, item.skillDraft);
      else await client.queueMessage(threadId, item.text, item.attachments, item.skillDraft, item.deliverAt);
    },
  });
}

/**
 * Everything that happens between the composer and the runtime: slash
 * commands, prepared prompts, optimistic rows, the transcript turn, the four
 * delivery paths and the recovery of a new thread's first message.
 */
export class SubmissionController {
  private turnSequence = 0;

  constructor(private readonly ports: SubmissionControllerPorts) {}

  /** A prompt the runtime failed after taking it goes back into its thread's composer, before what was typed since. */
  restoreFailedPrompt(clientMessageId: string, sessionId: string): void {
    const { view, scopes, storage } = this.ports;
    const sent = view.getOptimisticMessages().find((entry) => entry.message.clientMessageId === clientMessageId)?.sent;
    if (!sent) return;
    const scope = createDraftKey(draftKey(sessionId));
    const current = scopes.getSnapshot(scope);
    const draft = mergeNewThreadRecoveryDraft(sent.text, current.draft);
    if (draft !== current.draft) {
      scopes.setDraft(scope, draft);
      writeComposerDraft(storage, scope, draft);
    }
    const images = sent.attachments.flatMap((attachment) => attachment.kind !== "image" ? [] : [{
      ...attachment, id: allocateAttachmentId(), previewUrl: `data:${attachment.mimeType};base64,${attachment.data}`,
    }]);
    const attachments = mergeNewThreadRecoveryAttachments(images, current.attachments);
    if (attachments.length !== current.attachments.length) scopes.setAttachments(scope, attachments);
  }

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
    return this.ports.environment.selection(pending, this.ports.view.getSnapshot());
  }

  /** Offers the first prompt to an extension that starts the thread itself; true when one took it. */
  private claimNewThread = async (pending: NewThreadDraft, prompt: string, alternate: boolean, attachments: UiPromptAttachment[], skillDraft?: UiSkillDraft): Promise<boolean> => {
    const scope = draftKey(undefined, pending);
    if (!scope) return false;
    const { runtime, model, thinkingLevel, mode } = this.newThreadStart(pending);
    const notice = this.preparingNotice(pending, scope);
    try {
      return await this.ports.environment.claimNewThread({
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
      });
    } finally {
      notice.clear();
    }
  };

  private prepareNewThreadWorkspace = async (pending: NewThreadDraft, prompt: string, optimisticId: string): Promise<NewThreadDraft> => {
    const { environment, newThread } = this.ports;
    const scope = draftKey(undefined, pending);
    if (!scope) return pending;
    const { preparing, clear } = this.preparingNotice(pending, scope);
    try {
      const gate = await environment.prepareNewThread(
        { prompt, projectPath: pending.projectPath, ...(pending.workspaceId ? { workspaceId: pending.workspaceId } : {}), preparing },
      );
      // A stopped send is a rejected one: the caller takes the prompt back into the composer.
      if (gate?.stop) throw new Error(gate.stop);
      const moved = gate?.workspace;
      // The user may have left this draft while the gate worked.
      if (!moved) return pending;
      const next: NewThreadDraft = {
        ...pending,
        workspaceId: moved.workspaceId,
        projectPath: moved.displayPath,
        ...(moved.name ? { projectName: moved.name } : {}),
      };
      const nextScope = draftKey(undefined, next);
      this.ports.scopes.moveScope(createDraftKey(scope), createDraftKey(nextScope));
      if (newThread.current()?.draftId === pending.draftId) newThread.set(next);
      if (nextScope) retargetOptimisticMessage(this.ports.view, optimisticId, nextScope);
      this.ports.view.setOptimisticMessages((current) => current.map((entry) => entry.message.id === optimisticId ? { ...entry, draft: { ...next, draft: undefined } } : entry));
      return next;
    } finally {
      clear();
    }
  };

  submit = async (input: SubmissionInput, retry?: OptimisticUserMessage): Promise<SubmissionResult> => {
    const { client: getClient, view, threads, scopes, environment, newThread, turn, host } = this.ports;
    const { skillDraft } = input;
    const alternate = input.delivery === "alternate";
    const deliverAt = typeof input.delivery === "object" ? input.delivery.deliverAt : undefined;
    const delivery = input.delivery === "alternate" || typeof input.delivery === "object" ? undefined : input.delivery;
    const attachments = input.attachments ?? [];
    const text = skillDraft ? input.text : input.text.trim();
    const commandText = text.trim();
    if (!commandText && attachments.length === 0) return { accepted: false, message: "Enter a message or attach an image." };
    // UI commands are intercepted before any host or submission state changes.
    const command = attachments.length === 0 && !skillDraft ? environment.command(commandText) : undefined;
    if (command) return command();
    if (input.threadId !== undefined && (newThread.current() || view.getSnapshot()?.sessionId !== input.threadId)) {
      return this.sendOffScreen(input.threadId, text, attachments, skillDraft);
    }
    const client = getClient();
    let pendingNewThread = newThread.current();
    const newThreadRequestId = retry?.requestId ?? newThread.requestId();
    const snapshot = view.getSnapshot();
    const visibleStreaming = threads.getActivity().isStreaming || snapshot?.isCompacting === true;
    if (deliverAt !== undefined && (pendingNewThread || !snapshot)) return { accepted: false, message: "Send the first message before planning one." };
    const queueIt = deliverAt !== undefined || Boolean(retry && delivery === "followUp")
      || shouldQueueSubmission({ isPendingNewThread: Boolean(pendingNewThread), hasSnapshot: Boolean(snapshot), visibleStreaming, delivery });
    const built = buildOptimisticMessage({ text, attachments, skillDraft, sequence: this.turnSequence++, newThreadRequestId, ...(retry ? {
      identity: { clientTurnId: retry.message.clientTurnId!, clientMessageId: retry.message.clientMessageId! }, submittedAt: retry.message.timestamp,
    } : {}) });
    let optimistic = built.optimistic;
    const { clientTurn, logicalTurnId, clientMessageId } = built;
    const initialScope = draftKey(snapshot?.sessionId, pendingNewThread) ?? `session:${snapshot?.sessionId ?? "unknown"}`;
    // Machine selection and prompt preparation may each need a remote request.
    // Keep the submitted message visible throughout both waits.
    view.setOptimisticMessages((current) => {
      const entry = { scope: initialScope, message: optimistic, input: queueIt && deliverAt === undefined ? { ...input, delivery: "followUp" as const } : input, requestId: newThreadRequestId,
        ...(pendingNewThread ? { draft: { ...pendingNewThread, draft: undefined } } : {}),
        ...(!pendingNewThread && !queueIt ? { sent: { text, attachments } } : {}),
      };
      return current.some((item) => item.message.id === optimistic.id)
        ? current.map((item) => item.message.id === optimistic.id ? entry : item) : [...current, entry];
    });
    const markSent = () => view.setOptimisticMessages((current) => current.map((entry) => entry.message.id === optimistic.id
      ? { ...entry, message: { ...entry.message, submission: { state: "sent" as const } } } : entry));
    const retainFailure = (error: unknown): SubmissionResult => {
      const message = errorMessage(error);
      view.setOptimisticMessages((current) => current.map((entry) => entry.message.id === optimistic.id
        ? { ...entry, message: { ...entry.message, submission: { state: "failed" as const, error: message } } } : entry));
      return { accepted: false, retained: true, message };
    };
    const uncertainDelivery = (error: unknown) => isConnectionDropped(error) || error instanceof Error && "code" in error && error.code === "timeout";
    if (queueIt && snapshot) {
      try {
        await this.ports.enqueueFollowUp(snapshot.sessionId, { ...formatQueuedFollowUp(input.text, attachments, skillDraft), ...(deliverAt !== undefined ? { deliverAt } : {}), identity: clientTurn });
      } catch (error) {
        const confirmed = threads.getThread(snapshot.sessionId)?.queued?.some((message) => message.id === `queued-${clientMessageId}`);
        if (!confirmed && (retry || uncertainDelivery(error))) return retainFailure(error);
        if (!confirmed) {
          removeOptimisticMessage(view, optimistic.id);
          return { accepted: false, message: errorMessage(error) };
        }
      }
      removeOptimisticMessage(view, optimistic.id);
      environment.accepted();
      return { accepted: true };
    }

    try {
      if (pendingNewThread && !pendingNewThread.sessionId && await this.claimNewThread(pendingNewThread, text, alternate, attachments, skillDraft)) {
        removeOptimisticMessage(view, optimistic.id);
        environment.accepted();
        this.ports.drafts.startedElsewhere(pendingNewThread.draftId);
        return { accepted: true };
      }
    } catch (error) {
      if (uncertainDelivery(error)) return retainFailure(error);
      removeOptimisticMessage(view, optimistic.id);
      return { accepted: false, message: errorMessage(error) };
    }
    let prepared: PreparedPrompt | undefined;
    if (client) {
      try {
        prepared = await client.preparePrompt(
          text,
          pendingNewThread ? undefined : this.ports.hostSession.sessionIdFor(snapshot?.sessionId),
          skillDraft,
          pendingNewThread ? this.newThreadStart(pendingNewThread).requestedRuntime : undefined,
          pendingNewThread && !pendingNewThread.sessionId ? pendingNewThread.workspaceId ?? pendingNewThread.projectPath : undefined,
        );
      } catch (error) {
        if (uncertainDelivery(error)) return retainFailure(error);
        removeOptimisticMessage(view, optimistic.id);
        // ComposerScopeStore keeps the captured draft when a submission is
        // rejected, including edits made while preflight was in flight.
        // Re-seeding here would overwrite those newer edits.
        this.ports.notify(errorMessage(error), "error", SEND_FAILED_NOTICE);
        return { accepted: false, message: errorMessage(error) };
      }
    }
    if (prepared) {
      optimistic = { ...optimistic, text: prepared.visibleText, skill: undefined, skills: undefined, ...skillFields(prepared) };
      view.setOptimisticMessages((current) => current.map((entry) => entry.message.id === optimistic.id ? { ...entry, message: optimistic } : entry));
    }
    const visiblePrompt = prepared?.visibleText ?? built.visiblePrompt;
    // A draft may move to another project before its thread exists: this is
    // where Workspace Kit creates the worktree a new thread runs in (ADR 0017).
    // The prompt shows while the gate works and follows the draft if it moves.
    if (pendingNewThread && !pendingNewThread.sessionId) {
      try {
        pendingNewThread = await this.prepareNewThreadWorkspace(pendingNewThread, text, optimistic.id);
      } catch (error) {
        removeOptimisticMessage(view, optimistic.id);
        throw error;
      }
    }
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
    const rejectSubmission = (error: unknown): SubmissionResult => {
      const sessionId = pendingNewThread?.sessionId ?? snapshot?.sessionId;
      const messages = sessionId === view.getSnapshot()?.sessionId
        ? view.getTranscript().messages
        : sessionId ? view.details.get(sessionId)?.messages : undefined;
      if (messages?.some((message) => matchesTranscriptTurnMessage(message, {
        turnId: logicalTurnId, clientMessageId, messageId: optimistic.id,
        text: optimistic.text, timestamp: optimistic.timestamp,
      }))) return { accepted: true };
      const currentSubmission = isCurrentSubmission();
      cancelTranscriptTurn();
      if (retry || uncertainDelivery(error)) return retainFailure(error);
      removeOptimisticMessage(view, optimistic.id);
      if (currentSubmission) this.ports.notify(errorMessage(error), "error", SEND_FAILED_NOTICE);
      return { accepted: false, message: errorMessage(error) };
    };
    const submittedDraftKey = draftKey(snapshot?.sessionId, pendingNewThread);
    if (!pendingNewThread && visibleStreaming) {
      startTranscriptTurn(snapshot?.sessionId);
      try {
        if (!client) throw new Error("Steering requires a connected machine.");
        await client.steer(text, attachments, this.ports.hostSession.sessionIdFor(snapshot?.sessionId), clientTurn, prepared);
        markSent();
      } catch (error) {
        return rejectSubmission(error);
      }
      environment.accepted();
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
      try {
        if (!client) throw new Error("A new thread requires a connected machine.");
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
        // Left while its worktree and prompt were being prepared: the host must not put it on screen.
        const background = recovery?.detached === true;
        const result = await (requestedModel || thinkingLevel || mode || background
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
              ...(background ? { background } : {}),
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
      environment.unsettle(snapshot.sessionId);
    }
    startTranscriptTurn(snapshot?.sessionId);
    if (!client) return this.deliverInPreview();
    try {
      await client.sendPrompt(text, attachments, this.ports.hostSession.sessionIdFor(snapshot?.sessionId), clientTurn, prepared);
      markSent();
      void environment.submitted({ prompt: visiblePrompt, snapshot })
        .catch((error) => this.ports.notify(errorMessage(error), "error"));
      return { accepted: true };
    } catch (error) {
      return rejectSubmission(error);
    }
  };

  /** A message for a thread the user has left: it goes there, and the transcript on screen does not show it. */
  private sendOffScreen = async (threadId: string, text: string, attachments: UiPromptAttachment[], skillDraft?: UiSkillDraft): Promise<SubmissionResult> => {
    const client = this.ports.client();
    const sessionId = this.ports.hostSession.sessionIdFor(threadId);
    if (!client || !sessionId) return { accepted: false, message: "Sending to another thread requires a connected machine." };
    try {
      const prepared = await client.preparePrompt(text, sessionId, skillDraft);
      const { clientTurn } = buildOptimisticMessage({ text, attachments, skillDraft, prepared, sequence: this.turnSequence++ });
      if (this.ports.threads.getSnapshot().runningThreadIds.includes(threadId)) {
        await client.steer(text, attachments, sessionId, clientTurn, prepared);
      } else {
        this.ports.environment.unsettle(threadId);
        await client.sendPrompt(text, attachments, sessionId, clientTurn, prepared);
      }
    } catch (error) {
      return { accepted: false, message: errorMessage(error) };
    }
    return { accepted: true };
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
  private deliverInPreview(): SubmissionResult {
    const { view, threads } = this.ports;
    const previewThreadId = view.getSnapshot()?.sessionId ?? "";
    threads.setThreadRunning(previewThreadId, true);
    this.ports.environment.preview(() => {
      view.appendMessage({
        id: `mock-${Date.now()}`,
        role: "assistant",
        text: "Preview mode received the prompt. Launch `npm start` to send it through the real Pi SDK.",
        timestamp: Date.now(),
      });
      threads.setThreadRunning(previewThreadId, false);
    });
    return { accepted: true };
  }
}
