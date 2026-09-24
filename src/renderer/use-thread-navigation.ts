import { useCallback, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { UiProject } from "../shared/contracts";
import { namesWorkspace } from "../shared/workspace-identity";
import { optimisticThreadSnapshot } from "../workbench/app-state";
import type { ClientStorage } from "../workbench/client-storage";
import type { ComposerScopeStore, DraftKey } from "../workbench/composer-scope-store";
import { createNewThreadDraft, draftKey, writeNewThreadDraft, type NewThreadDraft } from "../workbench/draft-store";
import { errorMessage } from "../workbench/error-message";
import type { HostClient } from "../workbench/host-client";
import { activateTab, cycleTab, EMPTY_STAGE, pinTab, setFileView, unpinTab, type StageState, type StageView } from "../workbench/stage";
import type { ThreadStore } from "../workbench/thread-store";
import type { ThreadViewStore } from "../workbench/thread-view-store";
import type { TranscriptHistoryController, TransitionToken } from "../workbench/transcript-history";
import type { WorkbenchSession } from "../workbench/workbench-session";

export interface ThreadNavigationPorts {
  client?: HostClient;
  storage: ClientStorage;
  view: ThreadViewStore;
  threads: ThreadStore;
  history: TranscriptHistoryController;
  scopes: ComposerScopeStore;
  workbench: Pick<WorkbenchSession, "applyActionResult" | "applySnapshot" | "applyHostResult">;
  stage: StageState;
  setStage: Dispatch<SetStateAction<StageState>>;
  requireHost(what: string): boolean;
  /** A delivery in flight keeps going in its own thread when the user leaves the draft. */
  detachPendingDelivery(): boolean;
  newThread: {
    current(): NewThreadDraft | undefined;
    set: Dispatch<SetStateAction<NewThreadDraft | undefined>>;
    begin(draft: NewThreadDraft): void;
    invalidate(): void;
  };
  /** Read at call time: a draft scope changes with every thread switch. */
  activeDraftKey(): DraftKey | undefined;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  closeNewThreadPicker(): void;
}

/**
 * Moving between threads and projects, and the stage that follows them: the
 * one part of navigation that has to touch React, because a project change
 * empties the stage and a new draft takes the caret.
 *
 * Every port must keep its identity for the session. What this hook returns
 * reaches every extension through `WorkbenchActions`, and an action that
 * changes on each render re-runs every effect an extension hung on it.
 */
export function useThreadNavigation(ports: ThreadNavigationPorts) {
  const {
    activeDraftKey, client, closeNewThreadPicker, composerRef, detachPendingDelivery,
    history, newThread, requireHost, scopes, storage, threads, view, workbench, stage, setStage,
  } = ports;
  const { applyActionResult, applySnapshot, applyHostResult } = workbench;
  const notify = view.setNotice;

  const discardPendingNewThread = useCallback((expected?: NewThreadDraft): boolean => {
    const current = newThread.current();
    if (!current || (expected && current.draftId !== expected.draftId)) return false;
    newThread.invalidate();
    newThread.set(undefined);
    writeNewThreadDraft(storage);
    return true;
  }, [newThread, storage]);

  const moveDraftToProject = useCallback((project: UiProject) => {
    const scope = activeDraftKey();
    const mayCarryCurrentDraft = Boolean(newThread.current()) || view.getTranscript().messages.length === 0;
    const activeScope = mayCarryCurrentDraft && scope ? scopes.getSnapshot(scope) : undefined;
    // A submitted draft keeps delivering in the background. Its text is on its
    // way to the runtime, so there is nothing to carry into the fresh draft.
    const inFlight = detachPendingDelivery() || Boolean(activeScope?.submissionPending);
    const nextDraft = createNewThreadDraft({ projectPath: project.path, workspaceId: project.workspaceId, projectName: project.name });
    const destinationScope = draftKey(undefined, nextDraft);
    const sourceSnapshot = inFlight ? undefined : activeScope;
    // Only another unsubmitted draft may carry editor state into this new
    // scope. A real thread's scope can still own a pending submission; moving
    // it would make the fresh draft inherit that lifecycle and stay disabled.
    if (sourceSnapshot && scope && destinationScope) {
      scopes.transferDraft(scope, destinationScope);
    }
    // A new project is a new draft scope, but changing projects before the
    // first send should not discard what the user already composed. Attachments
    // stay memory-only and move with the scope; text also survives a reload.
    const draft = sourceSnapshot?.draft ? { ...nextDraft, draft: sourceSnapshot.draft } : nextDraft;
    newThread.begin(draft);
    closeNewThreadPicker();
    window.setTimeout(() => composerRef.current?.focus(), 0);
  }, [activeDraftKey, closeNewThreadPicker, composerRef, detachPendingDelivery, newThread, scopes, view]);

  const openWorkspace = useCallback(async (workspace: string, options?: { inheritDraft?: boolean }): Promise<boolean> => {
    const snapshot = view.getSnapshot();
    const pending = newThread.current();
    if (namesWorkspace(workspace, pending?.workspaceId ?? snapshot?.workspaceId, pending?.projectPath ?? snapshot?.cwd)) return true;
    const project = threads.getProjects().find((candidate) => namesWorkspace(workspace, candidate.workspaceId, candidate.path));
    const pendingScope = pending ? activeDraftKey() : undefined;
    const pendingInFlight = pendingScope ? scopes.getSnapshot(pendingScope).submissionPending : false;
    if (pending && project && !pendingInFlight) {
      moveDraftToProject(project);
      setStage(EMPTY_STAGE);
      return true;
    }
    if (!requireHost("Project switching")) return false;
    detachPendingDelivery();
    // A draft for another project sits above the still-active host thread. If
    // the user picks that host project again, revealing it is the whole switch.
    if (pending && namesWorkspace(workspace, snapshot?.workspaceId, snapshot?.cwd)) {
      discardPendingNewThread(pending);
      setStage(EMPTY_STAGE);
      return true;
    }
    try {
      const result = await client!.openProject(workspace);
      if (pending) discardPendingNewThread(pending);
      applyHostResult(result, options?.inheritDraft ?? !pendingInFlight);
      return true;
    } catch (error) {
      notify(errorMessage(error));
      return false;
    }
  }, [activeDraftKey, applyHostResult, client, detachPendingDelivery, discardPendingNewThread, moveDraftToProject, newThread, notify, requireHost, scopes, threads, view]);

  const createThreadInProject = moveDraftToProject;

  const switchSession = useCallback(async (path: string): Promise<boolean> => {
    if (!requireHost("Thread switching")) return false;
    const target = threads.getSnapshot().threads.find((session) => session.path === path);
    detachPendingDelivery();
    newThread.invalidate();
    newThread.set(undefined);
    writeNewThreadDraft(storage);
    const startedAt = performance.now();
    const previous = view.getSnapshot();
    const cached = target ? history.getDetail(target.id) : undefined;
    if (cached && previous && target) {
      applySnapshot(optimisticThreadSnapshot(previous, target, cached));
      view.addEvent("thread.switch.cached", target?.title);
    }
    const transition: TransitionToken = history.beginThreadSwitch(target?.id);
    // Before the switch is asked for, so the host streams the target from its snapshot on.
    const releaseTarget = target ? client!.watchThread(target.id) : undefined;
    try {
      const next = await client!.switchSession(path);
      if (!applyActionResult(next, transition)) return false;
      threads.markRead(target?.id ?? "");
      view.addEvent("thread.switch.confirmed", `${Math.round(performance.now() - startedAt)}ms`);
      return true;
    } catch (error) {
      if (!history.isCurrentThreadTransition(transition)) return false;
      if (previous) applySnapshot(previous);
      notify(errorMessage(error));
      return false;
    } finally {
      releaseTarget?.();
    }
  }, [applyActionResult, applySnapshot, client, detachPendingDelivery, history, newThread, notify, requireHost, storage, threads, view]);

  /** The one way out of a read-only thread tab: make it the thread on screen. */
  const takeOverThread = useCallback((sessionId: string) => {
    const path = threads.getThread(sessionId)?.path;
    if (path) void switchSession(path);
  }, [switchSession, threads]);

  // Closing a tab is not here: it asks the tab first, which is StageTabController's.
  const activateStage = useCallback((id: string) => setStage((current) => activateTab(current, id)), []);
  const pinStage = useCallback((id: string) => setStage((current) => pinTab(current, id)), []);
  const unpinStage = useCallback((id: string) => setStage((current) => unpinTab(current, id)), []);
  const setStageView = useCallback((id: string, stageView: StageView) => setStage((current) => setFileView(current, id, stageView)), []);
  const cycleStageTab = useCallback((direction: 1 | -1) => setStage((current) => cycleTab(current, direction)), []);

  return {
    stage, setStage, activateStage, pinStage, unpinStage, setStageView, cycleStageTab,
    applyHostResult, discardPendingNewThread, openWorkspace, createThreadInProject,
    switchSession, takeOverThread,
  };
}
