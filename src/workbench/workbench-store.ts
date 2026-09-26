import type { HostBootstrap, HostSnapshot, NewThreadRequestId, ThreadIndexSnapshot, UiMessage } from "../shared/contracts";
import {
  hostSnapshotFromThreadDetail,
  hostSnapshotWithCatalog,
  threadDetailFromHostSnapshot,
  type HostActionResult,
  type HostCatalog,
  type HostUpdate,
  type ProjectMetadata,
  type TranscriptPage,
} from "../shared/host-protocol";
import { matchesTranscriptTurnMessage } from "../shared/transcript-turn";
import { transcriptNavigationScopeKey } from "./app-state";
import { writeBootstrapCache } from "./bootstrap-cache";
import type { ClientStorage } from "./client-storage";
import { createDraftKey, type DraftKey } from "./composer-scope-store";
import { draftKey, type NewThreadDraft } from "./draft-store";
import type { HostSessionState } from "./host-session-state";
import type { ThreadStore } from "./thread-store";
import type { ThreadViewStore } from "./thread-view-store";
import type { TranscriptTurnPort } from "./turn-scope";
import type {
  TranscriptHistoryController,
  TranscriptBootstrapRequest,
  TranscriptHistoryRequest,
  TransitionToken,
} from "./transcript-history";
import { readCachedTurnActivity } from "./turn-activity";

/** Other clients' threads each leave one; only the newest few can still become the one on screen. */
const MAX_PENDING_PROJECTS = 8;

/** What the store needs of the unstarted thread the composer may be pointing at. */
export interface WorkbenchNewThreadPort {
  current(): NewThreadDraft | undefined;
  requestId(): NewThreadRequestId | undefined;
  promoteFromHostReport(sessionId: string, projectPath: string, requestId?: NewThreadRequestId): boolean;
}

/** A correlated detail that Session hands to delivery after reduction. */
export interface WorkbenchDeliveryObservation {
  sessionId: string;
  message: UiMessage;
  requestId?: NewThreadRequestId;
  projectPath: string;
  draftScope: DraftKey;
}

export interface WorkbenchSnapshotApplication {
  accepted: boolean;
  observation?: WorkbenchDeliveryObservation;
}

export interface WorkbenchStorePorts {
  view: ThreadViewStore;
  threads: ThreadStore;
  history: TranscriptHistoryController;
  storage: ClientStorage;
  hostSession: HostSessionState;
  newThread: WorkbenchNewThreadPort;
  turn: TranscriptTurnPort;
  notify(message: string): void;
}

/**
 * The one place a host update becomes workbench state. Every path in —
 * bootstrap, a push, the result of an action — ends here, so the thread index,
 * the thread on screen, its transcript pages and the bootstrap cache cannot
 * disagree about which thread the client is looking at.
 *
 * It owns no view and knows no client: what it reads it reads from the stores,
 * what it cannot decide alone it asks a port. That is what makes it the piece a
 * second client keeps when the window around it is a different one.
 */
export class WorkbenchStore {
  private cachedSnapshot?: HostSnapshot;
  private cachedIndex?: ThreadIndexSnapshot;
  private readonly pendingCatalogs = new Map<string, HostCatalog>();
  /** Project updates for threads not on screen, applied when their detail arrives. */
  private readonly pendingProjects = new Map<string, ProjectMetadata>();

  constructor(private readonly ports: WorkbenchStorePorts, cached?: { snapshot?: HostSnapshot; threadIndex?: ThreadIndexSnapshot }) {
    this.cachedSnapshot = cached?.snapshot;
    this.cachedIndex = cached?.threadIndex;
  }

  /** The snapshot last written to the bootstrap cache; the next paint starts from it. */
  getCachedSnapshot = (): HostSnapshot | undefined => this.cachedSnapshot;

  applySnapshotWithObservation = (next: HostSnapshot, request?: TranscriptBootstrapRequest): WorkbenchSnapshotApplication => {
    const { history, hostSession, storage, threads, view } = this.ports;
    if (request && !history.isCurrentBootstrap(request)) return { accepted: false };
    // The bootstrap cache paints before the host answers; from here on the
    // session id on screen is one this host really has open.
    hostSession.markApplied();
    view.beginThread(next.sessionId);
    const detail = threadDetailFromHostSnapshot(next);
    if (!history.syncSnapshot(next, detail, request)) return { accepted: false };
    // applyHostSnapshot and setActiveThread both report the thread's run state
    // to the one writer, so nothing else has to repeat it.
    threads.applyHostSnapshot(next);
    if (next.model?.provider) threads.setThreadModelProvider(next.sessionId, next.model.provider);
    const cachedActivity = readCachedTurnActivity(storage, next.sessionId);
    view.setSnapshot(next);
    view.setMessages(next.messages);
    const restoredActivity = next.turnActivity ?? cachedActivity;
    view.setTools(restoredActivity?.tools ?? []);
    view.setToolAnchorId(restoredActivity?.anchorMessageId);
    view.setTurnActivity(next.turnActivityHistory ?? [], restoredActivity ? next.sessionId : undefined);
    this.remember(next);
    const pending = this.ports.newThread.current();
    const message = next.messages.find((entry) => entry.role === "user");
    return {
      accepted: true,
      observation: pending && message
        ? {
          sessionId: next.sessionId,
          message,
          projectPath: next.cwd || pending.projectPath,
          draftScope: createDraftKey(draftKey(undefined, pending)),
        }
        : undefined,
    };
  };

  applySnapshot = (next: HostSnapshot, request?: TranscriptBootstrapRequest): boolean =>
    this.applySnapshotWithObservation(next, request).accepted;

  /** The host's first answer: the thread index and the thread it has open. */
  applyBootstrapWithObservation = (bootstrap: HostBootstrap, request: TranscriptBootstrapRequest): WorkbenchSnapshotApplication => {
    if (!this.ports.history.isCurrentBootstrap(request)) return { accepted: false };
    this.applyThreadIndex(bootstrap.threadIndex);
    const current = hostSnapshotFromThreadDetail({
      cwd: bootstrap.project.cwd,
      ...(bootstrap.project.workspaceId ? { workspaceId: bootstrap.project.workspaceId } : {}),
      ...(bootstrap.project.displayPath ? { displayPath: bootstrap.project.displayPath } : {}),
      projectLabel: bootstrap.project.label,
      sessionId: bootstrap.detail.sessionId,
      sessionTitle: bootstrap.threadIndex.sessions.find((thread) => thread.id === bootstrap.detail.sessionId)?.title ?? "Untitled thread",
      backendKind: bootstrap.detail.backendKind ?? bootstrap.catalog.backendKind,
      ...(bootstrap.catalog.runtimeBackends ? { runtimeBackends: bootstrap.catalog.runtimeBackends } : {}),
      ...(bootstrap.catalog.completionModels ? { completionModels: bootstrap.catalog.completionModels } : {}),
      ...(bootstrap.catalog.defaultBackendKind ? { defaultBackendKind: bootstrap.catalog.defaultBackendKind } : {}),
      models: bootstrap.catalog.models,
      model: bootstrap.catalog.model,
      runtimeCapabilities: bootstrap.catalog.runtimeCapabilities,
      thinkingLevel: bootstrap.catalog.thinkingLevel,
      thinkingLevels: bootstrap.catalog.thinkingLevels,
      allTools: bootstrap.catalog.allTools,
      composerCommands: bootstrap.catalog.composerCommands ?? [],
      extensionCount: bootstrap.catalog.extensionCount,
      supportsImageInput: bootstrap.catalog.supportsImageInput ?? false,
      messages: [],
      isStreaming: false,
      activeTools: [],
    }, bootstrap.detail);
    return this.applySnapshotWithObservation(current, request);
  };

  applyBootstrap = (bootstrap: HostBootstrap, request: TranscriptBootstrapRequest): boolean =>
    this.applyBootstrapWithObservation(bootstrap, request).accepted;

  applyThreadIndex = (threadIndex: ThreadIndexSnapshot): void => {
    this.ports.threads.applyThreadIndex(threadIndex);
    this.ports.history.setThreadIndex(threadIndex);
    this.cachedIndex = threadIndex;
    writeBootstrapCache(this.cachedSnapshot, threadIndex, this.ports.storage);
  };

  applyTranscriptPage = (page: TranscriptPage, request?: TranscriptHistoryRequest): boolean => {
    const { history, view } = this.ports;
    const application = history.applyPage(page, view.getTranscript().messages, request);
    if (!application) return false;
    view.setMessages(application.messages);
    const nextActivityHistory = application.snapshot?.turnActivityHistory ?? application.detail?.turnActivityHistory ?? [];
    view.setTurnActivityHistory(nextActivityHistory);
    if (application.snapshot) view.setSnapshot(application.snapshot);
    return true;
  };

  applyHostUpdate = (update: HostUpdate): WorkbenchDeliveryObservation | undefined => {
    const { history, threads, view } = this.ports;
    if (update.version !== 1) return undefined;
    if (update.type === "thread-index") {
      this.applyThreadIndex(update.index);
      return undefined;
    }
    if (update.type === "thread-shell") {
      const shell = update.update.shell;
      threads.applyThreadShell(update.update.sessionId, shell, update.update.removed);
      // The shell's total is the thread's own, priced anew when prices change.
      if (shell) view.setSnapshot((current) => current && current.sessionId === shell.id ? { ...current, sessionTitle: shell.title, projectLabel: shell.projectLabel, usage: shell.usage ?? current.usage } : current);
      return undefined;
    }
    if (update.type === "thread-detail") {
      return this.applyThreadDetail(update.detail);
    }
    if (update.type === "transcript-page") {
      this.applyTranscriptPage(update.page);
      return undefined;
    }
    if (update.type === "catalog") {
      if (update.catalog.model?.provider) threads.setThreadModelProvider(threads.getSnapshot().activeThreadId, update.catalog.model.provider);
      // The history cache is the base a later thread detail merges onto, so it
      // has to take the catalog too; otherwise the next detail restores the
      // model the thread had before this change.
      const catalogSnapshot = history.applyCatalog(update.catalog);
      const renderedSessionId = view.getSnapshot()?.sessionId;
      if (update.catalog.sessionId !== undefined
        && !catalogSnapshot
        && renderedSessionId !== update.catalog.sessionId) {
        // Runtime creation can publish its catalog before the correlated detail
        // has moved the transcript cache to the new session. Keep the catalog
        // until that detail arrives rather than silently dropping its model.
        this.pendingCatalogs.set(update.catalog.sessionId, update.catalog);
      }
      view.setSnapshot((current) => {
        if (!current || (update.catalog.sessionId !== undefined && current.sessionId !== update.catalog.sessionId)) return current;
        return this.remember(hostSnapshotWithCatalog(current, update.catalog));
      });
      return undefined;
    }
    if (update.type === "project") {
      const { sessionId, project } = update;
      // Another client's thread moved the host elsewhere; this one's thread stays in its project.
      if (sessionId !== undefined && view.getSnapshot()?.sessionId !== sessionId) {
        this.pendingProjects.delete(sessionId);
        this.pendingProjects.set(sessionId, project);
        if (this.pendingProjects.size > MAX_PENDING_PROJECTS) this.pendingProjects.delete(this.pendingProjects.keys().next().value!);
        return undefined;
      }
      // The history cache is the base the next detail merges onto; left behind, that detail drops the workspace id.
      if (sessionId === undefined || history.getCurrentSnapshot()?.sessionId === sessionId) history.applyProject(project);
      view.setSnapshot((current) => current ? { ...current, ...project } : current);
      return undefined;
    }
    if (update.type === "run") threads.setThreadRunning(update.sessionId, update.event === "started");
    if (update.type === "error") this.ports.notify(update.message);
    return undefined;
  };

  prepareActionResult = (result: HostActionResult, expectedTransition?: TransitionToken): boolean => {
    const { history } = this.ports;
    if (expectedTransition !== undefined && !history.isCurrentThreadTransition(expectedTransition)) return false;
    const detail = result.updates.find((update) => update.type === "thread-detail");
    if (detail?.type === "thread-detail") {
      const prepared = expectedTransition === undefined
        ? history.prepareActionDetail(detail.detail.sessionId)
        : history.confirmThreadTransition(expectedTransition, detail.detail.sessionId);
      if (!prepared) return false;
    }
    return true;
  };

  applyActionResult = (result: HostActionResult, expectedTransition?: TransitionToken): boolean => {
    if (!this.prepareActionResult(result, expectedTransition)) return false;
    result.updates.forEach((update) => this.applyHostUpdate(update));
    return true;
  };

  private applyThreadDetail(detail: Extract<HostUpdate, { type: "thread-detail" }>["detail"]): WorkbenchDeliveryObservation | undefined {
    const { history, hostSession, newThread, storage, threads, turn, view } = this.ports;
    hostSession.markApplied();
    const currentSnapshot = history.getCurrentSnapshot();
    const renderedSnapshot = view.getSnapshot();
    const shell = threads.getThread(detail.sessionId);
    const prompt = detail.messages.find((message) => message.role === "user")?.text;
    const pending = newThread.current();
    const isCorrelatedCandidate = Boolean(shell) || detail.sessionId !== currentSnapshot?.sessionId;
    // A bridge-created session can arrive after the new-session call has
    // returned with no updates. Prepare the history coordinator for that
    // one explicitly correlated transition before applying its detail; an
    // unrelated late detail must remain subject to the normal race guard.
    if (pending && prompt !== undefined && isCorrelatedCandidate
      && detail.requestId !== undefined && detail.requestId === newThread.requestId()) {
      history.prepareActionDetail(detail.sessionId);
    }
    const snapshotForDetail = currentSnapshot ? {
      ...currentSnapshot,
      sessionId: detail.sessionId,
      sessionTitle: shell?.title ?? currentSnapshot.sessionTitle,
      ...(currentSnapshot.sessionId === detail.sessionId ? {} : {
        supportsImageInput: false,
      }),
      // A new-thread acknowledgement can promote the explicit draft model
      // before its first host detail arrives. Preserve that choice as the
      // history baseline instead of reviving the previous thread's model.
      ...(renderedSnapshot?.sessionId === detail.sessionId && renderedSnapshot.model
        ? { model: renderedSnapshot.model }
        : {}),
    } : undefined;
    const application = history.applyDetail(detail, snapshotForDetail);
    if (!application) return undefined;
    const pendingProject = this.pendingProjects.get(detail.sessionId);
    if (pendingProject) {
      this.pendingProjects.delete(detail.sessionId);
      history.applyProject(pendingProject);
    }
    const pendingCatalog = this.pendingCatalogs.get(detail.sessionId);
    const catalogSnapshot = pendingCatalog ? history.applyCatalog(pendingCatalog) : undefined;
    if (pendingCatalog) this.pendingCatalogs.delete(detail.sessionId);
    const detailForRender = application.detail;
    const currentTurnStart = turn.current();
    const pendingDraft = newThread.current();
    if (currentTurnStart?.scope?.kind === "draft"
      && pendingDraft
      && currentTurnStart.scope.draftId === pendingDraft.draftId) {
      const matchedPrompt = detailForRender.messages.find((message) => matchesTranscriptTurnMessage(message, currentTurnStart));
      if (matchedPrompt) {
        turn.set({
          ...currentTurnStart,
          sessionId: detailForRender.sessionId,
          scope: { kind: "session", projectPath: pendingDraft.projectPath, sessionId: detailForRender.sessionId },
          messageId: matchedPrompt.id,
          scopeKey: transcriptNavigationScopeKey({ cwd: pendingDraft.projectPath, sessionId: detailForRender.sessionId }),
        }, currentTurnStart.turnId);
      }
    }
    view.details.set(detailForRender);
    const reportedMessage = detailForRender.messages.find((message) => message.role === "user");
    const pendingForReport = newThread.current();
    const deliveryObservation = isCorrelatedCandidate && reportedMessage && pendingForReport
      ? {
        sessionId: detail.sessionId,
        message: reportedMessage,
        requestId: detail.requestId,
        projectPath: shell?.projectPath ?? pendingForReport.projectPath,
        draftScope: createDraftKey(draftKey(undefined, pendingForReport)),
      } satisfies WorkbenchDeliveryObservation
      : undefined;
    threads.setActiveThread(detail.sessionId, detail.isStreaming);
    if (detailForRender.sessionId !== view.getState().activeThreadId) view.beginThread(detailForRender.sessionId);
    view.setMessages(detailForRender.messages);
    const cachedActivity = readCachedTurnActivity(storage, detailForRender.sessionId);
    const restoredActivity = detailForRender.turnActivity ?? cachedActivity;
    view.setTools(restoredActivity?.tools ?? []);
    view.setToolAnchorId(restoredActivity?.anchorMessageId);
    view.setTurnActivity(detailForRender.turnActivityHistory ?? [], restoredActivity ? detailForRender.sessionId : undefined);
    view.setSnapshot((current) => {
      const next = catalogSnapshot ?? application.snapshot ?? current;
      if (!next) return current;
      return this.remember({
        ...next,
        ...pendingProject,
        ...(detail.backendKind ? { backendKind: detail.backendKind } : {}),
        ...(detail.threadId ? { threadId: detail.threadId } : {}),
        ...(detail.providerSessionId ? { providerSessionId: detail.providerSessionId } : {}),
        turnActivityHistory: detailForRender.turnActivityHistory,
      });
    });
    return deliveryObservation;
  }

  /** The last snapshot the host confirmed, kept so the next start paints before the host answers. */
  private remember(snapshot: HostSnapshot): HostSnapshot {
    this.cachedSnapshot = snapshot;
    writeBootstrapCache(snapshot, this.cachedIndex, this.ports.storage);
    return snapshot;
  }
}
