import type { HostClient } from "./host-client";
import type { SubmissionController, SubmissionEnvironment, SubmissionInput } from "./submission-controller";
import type { HostBootstrap, HostSnapshot, NewThreadRequestId, ThreadIndexSnapshot, UiMessage, SubmissionResult, HostEvent } from "../shared/contracts";
import type { HostActionResult, HostUpdate } from "../shared/host-protocol";
import { draftKey, draftKeyOwner, readComposerDraft, writeNewThreadDraft } from "./draft-store";
import { createDraftKey, ComposerScopeStore } from "./composer-scope-store";
import { HostSessionState } from "./host-session-state";
import {
  NewThreadDeliveryCoordinator,
  type NewThreadDeliveryNotificationPort,
  type NewThreadDeliveryPort,
  type NewThreadDeliveryPromotion,
} from "./new-thread-delivery";
import { NewThreadController } from "./new-thread-controller";
import { DraftThreads } from "./draft-threads";
import { ThreadStages } from "./thread-stages";
import { ThreadStore } from "./thread-store";
import { SEND_FAILED_NOTICE, ThreadViewStore } from "./thread-view-store";
import { ToastStore } from "./toast-store";
import { TranscriptHistoryController, type TranscriptBootstrapRequest, type TranscriptHistoryRequest, type TransitionToken } from "./transcript-history";
import { reconcileOptimisticMessages, transcriptNavigationScopeKey, type OptimisticUserMessage } from "./app-state";
import { readSubmittedMessages, writeSubmittedMessages } from "./submitted-messages";
import { TurnScopeController } from "./turn-scope";
import { WorkbenchStore, type WorkbenchDeliveryObservation } from "./workbench-store";
import type { CachedBootstrap } from "./bootstrap-cache";
import type { ClientStorage } from "./client-storage";

export interface WorkbenchSessionOptions {
  storage: ClientStorage;
  cached?: CachedBootstrap;
  submission?: {
    client(): HostClient | undefined;
    environment: SubmissionEnvironment | (() => Promise<SubmissionEnvironment>);
    /** Optional renderer loader shares its idle preload with the first send. */
    load?(): Promise<typeof import("./submission-controller")>;
  };
  notification?: NewThreadDeliveryNotificationPort;
  /** Threads the user settled; a settled thread's stage is forgotten once it is long unopened. */
  settledThreadIds?(): readonly string[];
}

/**
 * The platform-neutral lifetime boundary for the renderer's workbench state.
 * Stores remain independently subscribable; this class owns the edges that
 * coordinate them, especially delivery promotion after host detail reduction.
 */
export class WorkbenchSession {
  readonly view: ThreadViewStore;
  readonly threads: ThreadStore;
  readonly history: TranscriptHistoryController;
  readonly scopes: ComposerScopeStore;
  readonly newThread: NewThreadController;
  /** The drafts the thread list shows; `threads.getDrafts()` reads them. */
  readonly drafts: DraftThreads;
  /** Each thread's and draft's stage, kept across switches and restarts. */
  readonly stages: ThreadStages;
  readonly hostSession: HostSessionState;
  readonly turn: TurnScopeController;
  /** The window's toast stack; notices become toasts in the client that draws them. */
  readonly toasts = new ToastStore();
  private readonly workbench: WorkbenchStore;
  readonly delivery: NewThreadDeliveryPort;

  private submission: SubmissionController | undefined;
  private submissionLoading: Promise<SubmissionController> | undefined;
  private readonly options: WorkbenchSessionOptions;
  private readonly deliveryCoordinator: NewThreadDeliveryCoordinator;

  constructor(options: WorkbenchSessionOptions) {
    this.options = options;
    const { cached, storage } = options;
    this.view = new ThreadViewStore(cached?.snapshot);
    this.view.setOptimisticMessages(reconcileOptimisticMessages(readSubmittedMessages(storage), cached?.snapshot.messages ?? []));
    this.view.subscribeToOptimistic(() => writeSubmittedMessages(storage, this.view.getOptimisticMessages()));
    this.threads = new ThreadStore();
    this.threads.subscribe(() => {
      const current = this.view.getOptimisticMessages();
      const next = current.filter((row) => !row.scope.startsWith("session:")
        || !this.threads.getThread(row.scope.slice("session:".length))?.queued?.some((queued) => queued.id === `queued-${row.message.clientMessageId}`));
      if (next.length !== current.length) this.view.setOptimisticMessages(next);
    });
    if (cached) {
      this.threads.applyThreadIndex(cached.threadIndex);
      this.threads.applyHostSnapshot(cached.snapshot);
    }
    this.history = new TranscriptHistoryController(cached?.snapshot, cached?.threadIndex, this.view.details);
    this.scopes = new ComposerScopeStore();
    this.newThread = new NewThreadController(storage);
    this.drafts = new DraftThreads({
      storage,
      scopes: this.scopes,
      newThread: this.newThread,
      publish: (drafts) => this.threads.setDrafts(drafts),
      submitted: {
        list: () => this.view.getOptimisticMessages().flatMap((entry) => entry.scope.startsWith("new:") && entry.draft ? [{
          draft: entry.draft, text: entry.message.text, sending: entry.message.submission?.state === "sending",
        }] : []),
        subscribe: this.view.subscribeToOptimistic,
        discard: (draftId) => this.view.setOptimisticMessages((rows) => rows.filter((entry) => !entry.scope.startsWith("new:") || entry.draft?.draftId !== draftId)),
      },
      threads: {
        listed: (sessionId) => (this.threads.getThread(sessionId)?.messageCount ?? 0) > 0,
        active: (sessionId) => this.threads.getSnapshot().activeThreadId === sessionId,
        subscribe: this.threads.subscribe,
      },
    });
    this.stages = new ThreadStages({
      storage,
      threads: () => this.threads.getSnapshot().threads,
      drafts: () => this.drafts.list().map((draft) => draft.draftId),
      ...(options.settledThreadIds ? { settled: options.settledThreadIds } : {}),
    });
    // Every promotion moves the draft's composer scope to its thread's; the stage goes along.
    this.scopes.onMove((from, to) => {
      const draft = draftKeyOwner(from);
      const thread = draftKeyOwner(to);
      if (draft && "draftId" in draft && thread && "sessionId" in thread) this.stages.promote(draft.draftId, thread.sessionId);
    });
    this.hostSession = new HostSessionState();
    this.turn = new TurnScopeController(() => this.currentScopeKey());

    this.deliveryCoordinator = new NewThreadDeliveryCoordinator({
      projection: {
        view: this.view,
        threads: this.threads,
        scopes: this.scopes,
        storage,
        newThread: {
          current: this.newThread.current,
          set: this.newThread.set,
          promoteFromUserMessage: this.newThread.promoteFromUserMessage,
        },
        turn: this.turn,
        retainDraftRow: this.drafts.handoff,
      },
      notification: options.notification ?? { notifyPromptSubmitted: () => true },
    });

    this.workbench = new WorkbenchStore({
      view: this.view,
      threads: this.threads,
      history: this.history,
      storage,
      hostSession: this.hostSession,
      newThread: {
        current: this.newThread.current,
        requestId: this.newThread.requestId,
        promoteFromHostReport: this.newThread.promoteFromHostReport,
      },
      turn: this.turn,
      notify: this.view.setNotice,
    }, cached);

    this.delivery = {
      register: (clientMessageId, recovery) => this.deliveryCoordinator.register(clientMessageId, recovery),
      hasRecovery: this.deliveryCoordinator.hasRecovery,
      recoveryScope: this.deliveryCoordinator.recoveryScope,
      markWithoutUserTurn: this.deliveryCoordinator.markWithoutUserTurn,
      markIpcSettled: this.deliveryCoordinator.markIpcSettled,
      promoteReportedThread: (sessionId, message, requestId) => this.promoteReportedThread(sessionId, message, requestId),
      promoteRecovery: (clientMessageId, sessionId, message) => this.promoteRecovery(clientMessageId, sessionId, message),
      settleDelivery: (clientMessageId, sessionId, settlement) => this.settleDelivery(clientMessageId, sessionId, settlement),
      // A sent optimistic row can exist only after the submission controller loaded.
      restoreFailedPrompt: (clientMessageId, sessionId) => this.submission?.restoreFailedPrompt(clientMessageId, sessionId),
      detachPendingDelivery: this.deliveryCoordinator.detachPendingDelivery,
      release: this.deliveryCoordinator.release,
      rehomeDetached: (clientMessageId, recovery, sessionId) => this.deliveryCoordinator.rehomeDetached(clientMessageId, recovery, sessionId),
      notifyPromptSubmitted: (pending, sessionId, prompt, recovery) => this.deliveryCoordinator.notifyPromptSubmitted(pending, sessionId, prompt, recovery),
    };
  }

  /** One submission operation; construction and delivery state stay in the session. */
  submit = async (input: SubmissionInput, retry?: OptimisticUserMessage): Promise<SubmissionResult> => {
    const adapter = this.options.submission;
    if (!adapter) return { accepted: false, message: "The workbench is not ready yet." };
    if (!this.submission) {
      this.submissionLoading ??= (adapter.load ? adapter.load() : import("./submission-controller"))
        .then(async ({ createSubmissionController }) => {
          const environment = typeof adapter.environment === "function" ? await adapter.environment() : adapter.environment;
          const controller = createSubmissionController({
            client: adapter.client,
            environment,
            storage: this.options.storage,
            view: this.view,
            threads: this.threads,
            scopes: this.scopes,
            hostSession: this.hostSession,
            delivery: this.delivery,
            notify: this.view.setNotice,
            newThread: this.newThread,
            drafts: this.drafts,
            turn: this.turn,
            host: this,
          });
          this.submission = controller;
          return controller;
        }).catch((error) => { this.submissionLoading = undefined; throw error; });
      await this.submissionLoading;
    }
    const result = await this.submission!.submit(input, retry);
    // An earlier send's failure toast goes once a later send goes through.
    if (result.accepted) this.toasts.dismiss(SEND_FAILED_NOTICE);
    return result;
  };

  retryMessage = async (messageId: string): Promise<void> => {
    const { retrySubmittedMessage } = await import("./submission-controller");
    await retrySubmittedMessage(this, messageId);
  };

  /** Reconcile authoritative detail as well as live user events, before returning to the caller. */
  private reconcileSubmission(): void {
    const current = this.view.getOptimisticMessages();
    const reconciled = reconcileOptimisticMessages(current, this.view.getTranscript().messages);
    if (reconciled.length === current.length) return;
    const pending = this.newThread.current();
    const pendingScope = draftKey(undefined, pending);
    if (pending && current.some((entry) => entry.scope === pendingScope)
      && reconciled.every((entry) => entry.scope !== pendingScope)) {
      writeNewThreadDraft(this.options.storage);
      this.newThread.set(undefined);
    }
    this.view.setOptimisticMessages(reconciled);
  }

  getCachedSnapshot = (): HostSnapshot | undefined => this.workbench.getCachedSnapshot();

  applySnapshot = (snapshot: HostSnapshot, request?: TranscriptBootstrapRequest): boolean => {
    const application = this.workbench.applySnapshotWithObservation(snapshot, request);
    if (application.accepted) {
      this.processDeliveryObservation(application.observation);
      this.reconcileSubmission();
    }
    return application.accepted;
  };

  applyBootstrap = (bootstrap: HostBootstrap, request: TranscriptBootstrapRequest): boolean => {
    const application = this.workbench.applyBootstrapWithObservation(bootstrap, request);
    if (application.accepted) {
      this.processDeliveryObservation(application.observation);
      this.stages.sweep();
      this.reconcileSubmission();
    }
    return application.accepted;
  };

  applyThreadIndex = (index: ThreadIndexSnapshot): void => {
    this.workbench.applyThreadIndex(index);
    this.stages.sweep();
  };

  applyTranscriptPage = (page: Parameters<WorkbenchStore["applyTranscriptPage"]>[0], request?: TranscriptHistoryRequest): boolean => {
    const accepted = this.workbench.applyTranscriptPage(page, request);
    if (accepted) this.reconcileSubmission();
    return accepted;
  };

  /** Reduce one host update, then route any correlated delivery observation. */
  applyHostUpdate = (update: HostUpdate): void => {
    this.reduceHostUpdate(update);
  };

  /** A live echo commits held delivery before reducing and reconciling its row. */
  applyUserMessage = (event: Extract<HostEvent, { type: "user-message" }>): void => {
    const clientMessageId = event.message.clientMessageId;
    if (clientMessageId && this.delivery.hasRecovery(clientMessageId)) {
      this.delivery.promoteRecovery(clientMessageId, event.sessionId, event.message);
    }
    this.view.dispatch(event);
    this.reconcileSubmission();
  };

  applyActionResult = (result: HostActionResult, expectedTransition?: TransitionToken): boolean => {
    if (!this.workbench.prepareActionResult(result, expectedTransition)) return false;
    for (const update of result.updates) this.reduceHostUpdate(update);
    return true;
  };

  /**
   * Apply a navigation result and carry the current scope's draft into the
   * resulting thread. The DOM remains outside this operation; ComposerScope
   * is the synchronous source of truth for text already typed.
   */
  applyHostResult = (result: HostActionResult, inheritDraft = true): void => {
    const currentScope = createDraftKey(draftKey(this.view.getSnapshot()?.sessionId, this.newThread.current()));
    const pendingDraft = inheritDraft ? this.scopes.getSnapshot(currentScope).draft : "";
    this.applyActionResult(result);
    const detail = result.updates.find((update) => update.type === "thread-detail");
    if (!pendingDraft || detail?.type !== "thread-detail") return;
    // A thread with a draft of its own keeps it; the carried text stays where it was typed.
    const destination = draftKey(detail.detail.sessionId);
    if (this.scopes.getSnapshot(createDraftKey(destination)).draft || readComposerDraft(this.options.storage, destination)) return;
    this.scopes.setDraft(createDraftKey(destination), pendingDraft);
  };

  prepareThreadDetail = (sessionId: string): boolean => this.history.prepareActionDetail(sessionId);

  private reduceHostUpdate(update: HostUpdate, processDelivery = true): void {
    const observation = this.workbench.applyHostUpdate(update);
    if (update.type === "thread-index") this.stages.sweep();
    if (update.type === "thread-shell" && update.update.removed) this.stages.forgetThread(update.update.sessionId);
    if (processDelivery) this.processDeliveryObservation(observation);
    this.reconcileSubmission();
  }

  private processDeliveryObservation(observation: WorkbenchDeliveryObservation | undefined): void {
    if (!observation) return;
    const promotion = this.deliveryCoordinator.promoteReportedThread(
      observation.sessionId,
      observation.message,
      observation.requestId,
    );
    if (promotion.status === "promoted") {
      this.applyPromotion(promotion);
      return;
    }
    if (promotion.status !== "none") return;

    // This is the legacy bridge path: no held recovery exists, but the
    // controller has an explicitly awaiting request. Keep its request and
    // project guards here so an unrelated detail cannot promote another draft.
    const pending = this.newThread.current();
    if (!pending || draftKey(undefined, pending) !== observation.draftScope) return;
    if (!this.newThread.promoteFromHostReport(observation.sessionId, observation.projectPath, observation.requestId)) return;
    this.scopes.moveScope(observation.draftScope, createDraftKey(draftKey(observation.sessionId)));
  }

  private promoteReportedThread(sessionId: string, message: UiMessage, requestId?: NewThreadRequestId): boolean {
    return this.applyPromotion(this.deliveryCoordinator.promoteReportedThread(sessionId, message, requestId));
  }

  private promoteRecovery(clientMessageId: string, sessionId: string, message?: UiMessage): boolean {
    return this.applyPromotion(this.deliveryCoordinator.promoteRecovery(clientMessageId, sessionId, message));
  }

  private applyPromotion(promotion: NewThreadDeliveryPromotion): boolean {
    if (!promotion.promoted) return false;
    if (promotion.detail?.type === "thread-detail") {
      // The coordinator has already moved the recovery's scope and draft. The
      // synthetic detail must still pass through history and view in the same
      // order as a real host detail, without a second delivery observation.
      this.history.prepareActionDetail(promotion.detail.detail.sessionId);
      this.reduceHostUpdate(promotion.detail, false);
    }
    this.deliveryCoordinator.finishPromotion(promotion);
    return true;
  }

  private settleDelivery(
    clientMessageId: string,
    sessionId: string,
    settlement: { accepted: true } | { accepted: false; message: string },
  ): boolean {
    const plan = this.deliveryCoordinator.settleDeliveryPlan(clientMessageId, sessionId, settlement);
    if (plan.promotion?.promoted) this.applyPromotion(plan.promotion);
    return plan.handled;
  }

  private currentScopeKey(): string {
    return transcriptNavigationScopeKey(this.view.getSnapshot(), this.newThread.current());
  }
}
