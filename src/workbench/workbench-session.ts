import type { HostBootstrap, HostSnapshot, NewThreadRequestId, ThreadIndexSnapshot, UiMessage } from "../shared/contracts";
import type { HostActionResult, HostUpdate } from "../shared/host-protocol";
import { draftKey } from "./draft-store";
import { createDraftKey, ComposerScopeStore } from "./composer-scope-store";
import { HostSessionState } from "./host-session-state";
import {
  NewThreadDeliveryCoordinator,
  type NewThreadDeliveryNotificationPort,
  type NewThreadDeliveryPort,
  type NewThreadDeliveryPromotion,
} from "./new-thread-delivery";
import { NewThreadController } from "./new-thread-controller";
import { ThreadStore } from "./thread-store";
import { ThreadViewStore } from "./thread-view-store";
import { ToastStore } from "./toast-store";
import { TranscriptHistoryController, type TranscriptBootstrapRequest, type TranscriptHistoryRequest, type TransitionToken } from "./transcript-history";
import { transcriptNavigationScopeKey } from "./app-state";
import { TurnScopeController } from "./turn-scope";
import { WorkbenchStore, type WorkbenchDeliveryObservation } from "./workbench-store";
import type { CachedBootstrap } from "./bootstrap-cache";
import type { ClientStorage } from "./client-storage";

export interface WorkbenchSessionOptions {
  storage: ClientStorage;
  cached?: CachedBootstrap;
  notification?: NewThreadDeliveryNotificationPort;
  /** Renderer-only stage cleanup when a navigation result changes project. */
  onProjectChange?: () => void;
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
  readonly hostSession: HostSessionState;
  readonly turn: TurnScopeController;
  /** The window's toast stack; notices become toasts in the client that draws them. */
  readonly toasts = new ToastStore();
  private readonly workbench: WorkbenchStore;
  readonly delivery: NewThreadDeliveryPort;

  private readonly deliveryCoordinator: NewThreadDeliveryCoordinator;
  private readonly onProjectChange?: () => void;

  constructor(options: WorkbenchSessionOptions) {
    const { cached, storage } = options;
    this.onProjectChange = options.onProjectChange;
    this.view = new ThreadViewStore(cached?.snapshot);
    this.threads = new ThreadStore();
    if (cached) {
      this.threads.applyThreadIndex(cached.threadIndex);
      this.threads.applyHostSnapshot(cached.snapshot);
    }
    this.history = new TranscriptHistoryController(cached?.snapshot, cached?.threadIndex, this.view.details);
    this.scopes = new ComposerScopeStore();
    this.newThread = new NewThreadController(storage);
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
      detachPendingDelivery: this.deliveryCoordinator.detachPendingDelivery,
      release: this.deliveryCoordinator.release,
      rehomeDetached: (clientMessageId, recovery, sessionId) => this.deliveryCoordinator.rehomeDetached(clientMessageId, recovery, sessionId),
      notifyPromptSubmitted: (pending, sessionId, prompt, recovery) => this.deliveryCoordinator.notifyPromptSubmitted(pending, sessionId, prompt, recovery),
    };
  }

  getCachedSnapshot = (): HostSnapshot | undefined => this.workbench.getCachedSnapshot();

  applySnapshot = (snapshot: HostSnapshot, request?: TranscriptBootstrapRequest): boolean => {
    const application = this.workbench.applySnapshotWithObservation(snapshot, request);
    if (application.accepted) this.processDeliveryObservation(application.observation);
    return application.accepted;
  };

  applyBootstrap = (bootstrap: HostBootstrap, request: TranscriptBootstrapRequest): boolean => {
    const application = this.workbench.applyBootstrapWithObservation(bootstrap, request);
    if (application.accepted) this.processDeliveryObservation(application.observation);
    return application.accepted;
  };

  applyThreadIndex = (index: ThreadIndexSnapshot): void => {
    this.workbench.applyThreadIndex(index);
  };

  applyTranscriptPage = (page: Parameters<WorkbenchStore["applyTranscriptPage"]>[0], request?: TranscriptHistoryRequest): boolean =>
    this.workbench.applyTranscriptPage(page, request);

  /** Reduce one host update, then route any correlated delivery observation. */
  applyHostUpdate = (update: HostUpdate): void => {
    this.reduceHostUpdate(update);
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
    const previousCwd = this.view.getSnapshot()?.cwd;
    this.applyActionResult(result);
    const cwd = result.updates.find((update) => update.type === "project")?.project.cwd;
    if (cwd && cwd !== previousCwd) this.onProjectChange?.();
    const detail = result.updates.find((update) => update.type === "thread-detail");
    if (pendingDraft && detail?.type === "thread-detail") {
      this.scopes.setDraft(createDraftKey(draftKey(detail.detail.sessionId)), pendingDraft);
    }
  };

  prepareThreadDetail = (sessionId: string): boolean => this.history.prepareActionDetail(sessionId);

  private reduceHostUpdate(update: HostUpdate, processDelivery = true): void {
    const observation = this.workbench.applyHostUpdate(update);
    if (processDelivery) this.processDeliveryObservation(observation);
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
