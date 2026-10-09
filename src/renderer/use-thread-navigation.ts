import { useCallback, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { HostBootstrap, UiProject } from "../shared/contracts";
import type { ThreadDetail, TranscriptPage } from "../shared/host-protocol";
import { namesWorkspace } from "../shared/workspace-identity";
import { optimisticThreadSnapshot, threadDetailFromPage } from "../workbench/app-state";
import type { ClientStorage } from "../workbench/client-storage";
import type { ComposerScopeStore, DraftKey } from "../workbench/composer-scope-store";
import { createNewThreadDraft, draftKey, writeNewThreadDraft, type NewThreadDraft } from "../workbench/draft-store";
import type { DraftThreads } from "../workbench/draft-threads";
import { errorMessage } from "../workbench/error-message";
import type { HostClient } from "../workbench/host-client";
import { startDraftProject, startDraftState } from "../workbench/new-thread-project";
import { activateTab, cycleTab, pinTab, setFileView, unpinTab, type StageState, type StageView } from "../workbench/stage";
import type { ThreadStore } from "../workbench/thread-store";
import type { ThreadViewStore } from "../workbench/thread-view-store";
import type { TranscriptHistoryController, TransitionToken } from "../workbench/transcript-history";
import type { WorkbenchSession } from "../workbench/workbench-session";

/** Whether the persisted page holds a message the cached detail lacks. */
function addsMessages(cached: ThreadDetail, page: TranscriptPage): boolean {
  const known = new Set(cached.messages.map((message) => message.id));
  return page.messages.some((message) => !known.has(message.id));
}

export interface ShowThreadOptions {
  /** A new draft: the caret goes to its composer once the chat is in view. */
  focusComposer?: boolean;
}

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
  /** The drafts the thread list shows; a draft left with something in it stays there. */
  drafts: Pick<DraftThreads, "keep" | "take" | "discard" | "find">;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  closeNewThreadPicker(): void;
  /** Read before a new draft begins: it starts on what the draft or thread on screen runs. */
  inheritSelection?(): void;
  /** A thread was asked for, the one on screen too: its chat comes to the front. */
  showThread(options?: ShowThreadOptions): void;
}

/**
 * Moving between threads and projects, and the stage's own gestures: the one
 * part of navigation that has to touch React, because a new draft takes the
 * caret. Each thread and draft keeps its own stage (`useWorkbenchLayoutState`).
 *
 * Every port must keep its identity for the session. What this hook returns
 * reaches every extension through `WorkbenchActions`, and an action that
 * changes on each render re-runs every effect an extension hung on it.
 */
export function useThreadNavigation(ports: ThreadNavigationPorts) {
  const {
    activeDraftKey, client, closeNewThreadPicker, composerRef, detachPendingDelivery, drafts,
    history, inheritSelection, newThread, requireHost, scopes, showThread, storage, threads, view, workbench, stage, setStage,
  } = ports;
  const { applyActionResult, applySnapshot, applyHostResult } = workbench;
  const notify = view.setNotice;

  /** The draft on screen is left: it stays in the list with what it holds, unless it is empty or being sent. */
  const leavePendingNewThread = useCallback((expected?: NewThreadDraft, sending = false): boolean => {
    const current = newThread.current();
    if (!current || (expected && current.draftId !== expected.draftId)) return false;
    if (!sending) drafts.keep(current);
    newThread.invalidate();
    newThread.set(undefined);
    writeNewThreadDraft(storage);
    return true;
  }, [drafts, newThread, storage]);

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
    // The new draft has a stage of its own; the one left keeps its.
    if (pending && project && !pendingInFlight) {
      moveDraftToProject(project);
      return true;
    }
    if (!requireHost("Project switching")) return false;
    detachPendingDelivery();
    // A draft for another project sits above the still-active host thread. If
    // the user picks that host project again, revealing it is the whole switch.
    if (pending && namesWorkspace(workspace, snapshot?.workspaceId, snapshot?.cwd)) {
      leavePendingNewThread(pending);
      return true;
    }
    try {
      const result = await client!.openProject(workspace);
      if (pending) leavePendingNewThread(pending, pendingInFlight);
      applyHostResult(result, options?.inheritDraft ?? !pendingInFlight);
      return true;
    } catch (error) {
      notify(errorMessage(error));
      return false;
    }
  }, [activeDraftKey, applyHostResult, client, detachPendingDelivery, leavePendingNewThread, moveDraftToProject, newThread, notify, requireHost, scopes, threads, view]);

  /**
   * A new thread's draft in `project`. A draft with something in
   * it stays in the list and a fresh one opens; `carry` moves it instead (the
   * start screen's project button).
   */
  const createThreadInProject = useCallback((project: UiProject, options?: { carry?: boolean }) => {
    inheritSelection?.();
    showThread({ focusComposer: true });
    const current = newThread.current();
    const scope = current ? activeDraftKey() : undefined;
    if (current && !options?.carry && !(scope && scopes.getSnapshot(scope).submissionPending)) {
      leavePendingNewThread(current, detachPendingDelivery());
    }
    moveDraftToProject(project);
  }, [activeDraftKey, detachPendingDelivery, inheritSelection, leavePendingNewThread, moveDraftToProject, newThread, scopes, showThread]);

  /** At startup the host opens an empty thread; a draft takes its place, as "New thread" would. */
  const openStartDraft = useCallback((bootstrap: HostBootstrap) => {
    const project = client?.isReadOnly() ? undefined : startDraftProject(bootstrap, threads.getProjects());
    if (!project) return;
    const startId = bootstrap.detail.sessionId;
    // The full index arrives after the bootstrap; until then a fresh install looks like any start.
    const settle = (): boolean => {
      if (newThread.current() || view.getSnapshot()?.sessionId !== startId || view.getTranscript().messages.length) return true;
      const state = startDraftState(threads.getSnapshot().threads, startId);
      if (state === "open") moveDraftToProject(project);
      return state !== "wait";
    };
    if (settle()) return;
    const stop = threads.subscribe(() => { if (settle()) stop(); });
  }, [client, moveDraftToProject, newThread, threads, view]);

  /** Throws a draft away; the draft on screen closes onto the thread the host has open. */
  const discardDraft = useCallback((draftId: string) => {
    const current = newThread.current();
    if (current?.draftId === draftId) {
      if (detachPendingDelivery()) return;
      drafts.discard(current);
      newThread.invalidate();
      newThread.set(undefined);
      writeNewThreadDraft(storage);
      return;
    }
    const draft = drafts.find(draftId);
    if (draft) drafts.discard(draft);
  }, [detachPendingDelivery, drafts, newThread, storage]);

  const switchSession = useCallback(async (path: string): Promise<boolean> => {
    if (!requireHost("Thread switching")) return false;
    showThread();
    const target = threads.getSnapshot().threads.find((session) => session.path === path);
    const sending = detachPendingDelivery();
    leavePendingNewThread(undefined, sending);
    const startedAt = performance.now();
    const previous = view.getSnapshot();
    const cached = target ? history.getDetail(target.id) : undefined;
    if (cached && previous && target) {
      applySnapshot(optimisticThreadSnapshot(previous, target, cached));
      view.addEvent("thread.switch.cached", target?.title);
    }
    let transition: TransitionToken = history.beginThreadSwitch(target?.id);
    // Before the switch is asked for, so the host streams the target from its snapshot on.
    const releaseTarget = target ? client!.watchThread(target.id) : undefined;
    let confirmed = false;
    let previewed = false;
    // The persisted page is on screen before the host has opened the thread's runtime. A cached
    // detail stops following the thread once it leaves the screen, so a newer page replaces it.
    if (previous && target) {
      void client!.loadTranscript(target.id).then((page) => {
        if (confirmed || !page.messages.length || !history.isCurrentThreadTransition(transition)) return;
        if (cached && !addsMessages(cached, page)) return;
        applySnapshot(optimisticThreadSnapshot(previous, target, threadDetailFromPage(page, target)));
        // Painting the page settles the history's transition; the host's answer needs one of its own.
        transition = history.beginThreadSwitch(target.id);
        previewed = true;
        view.addEvent("thread.switch.preview", target.title);
      }, () => undefined);
    }
    try {
      const next = await client!.switchSession(path);
      confirmed = true;
      // The page is longer than the host's first one; merged, it would stand for history the host never paged.
      if (previewed && history.isCurrentThreadTransition(transition)) view.details.delete(target!.id);
      if (!applyActionResult(next, transition)) return false;
      threads.markRead(target?.id ?? "");
      view.addEvent("thread.switch.confirmed", `${Math.round(performance.now() - startedAt)}ms`);
      return true;
    } catch (error) {
      confirmed = true;
      if (!history.isCurrentThreadTransition(transition)) return false;
      if (previous) applySnapshot(previous);
      notify(errorMessage(error));
      return false;
    } finally {
      releaseTarget?.();
    }
  }, [applyActionResult, applySnapshot, client, detachPendingDelivery, history, leavePendingNewThread, notify, requireHost, showThread, threads, view]);

  /** A draft from the list becomes the draft on screen again; the one it replaces is left. */
  const openDraft = useCallback((draftId: string) => {
    showThread({ focusComposer: true });
    const current = newThread.current();
    if (current?.draftId === draftId) return;
    const row = threads.getDrafts().find((entry) => entry.draftId === draftId);
    const thread = row?.sessionId ? threads.getThread(row.sessionId) : undefined;
    if (thread) { void switchSession(thread.path); return; }
    const draft = drafts.find(draftId);
    if (!draft) return;
    if (current) leavePendingNewThread(current, detachPendingDelivery());
    drafts.take(draftId);
    newThread.begin(draft);
    closeNewThreadPicker();
  }, [closeNewThreadPicker, detachPendingDelivery, drafts, leavePendingNewThread, newThread, showThread, switchSession, threads]);

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
    applyHostResult, openWorkspace, createThreadInProject, openDraft, discardDraft,
    switchSession, takeOverThread, openStartDraft,
  };
}
