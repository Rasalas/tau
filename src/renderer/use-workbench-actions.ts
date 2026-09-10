import { useMemo, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { HostSnapshot } from "../shared/contracts";
import type { HostActionResult } from "../shared/host-protocol";
import type { HostClient } from "../workbench/host-client";
import type { Platform } from "../workbench/platform";
import type { ThreadStore } from "../workbench/thread-store";
import type { ThreadViewStore } from "../workbench/thread-view-store";
import type { ComposerScopeStore, DraftKey } from "../workbench/composer-scope-store";
import type { ThreadCommands } from "../workbench/thread-commands";
import type { NewThreadDraft } from "../workbench/draft-store";
import type { WorkbenchActions } from "./extension-system";

export interface UseWorkbenchActionsOptions {
  client: HostClient | undefined;
  platform: Platform;
  threadStore: ThreadStore;
  viewStore: ThreadViewStore;
  composerScopeStore: ComposerScopeStore;
  threadCommands: ThreadCommands;
  snapshot: HostSnapshot | undefined;
  pendingNewThread: NewThreadDraft | undefined;
  workspaceCwd: string | undefined;
  newThreadDeliveryPending: boolean;
  activeDraftKey: DraftKey | undefined;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  transcriptRef: RefObject<HTMLDivElement | null>;
  openPanel: (id: string) => void;
  openPalette: () => void;
  setSettingsPage: (page?: string) => void;
  openNewThreadPicker: () => void;
  switchSession: WorkbenchActions["switchSession"];
  settleActiveThread: () => void;
  isVisibleThreadRunning: () => boolean;
  reloadWorkbench: WorkbenchActions["reloadWorkbench"];
  openThreadTree: WorkbenchActions["openThreadTree"];
  duplicateThread: WorkbenchActions["duplicateThread"];
  setComposerSeed: (seed: string) => void;
  setDockOpen: Dispatch<SetStateAction<boolean>>;
  setNotice: (notice: any) => void;
  openProjectSources: () => void;
  applyHostResult: (result: HostActionResult) => void;
  closeActiveStageTab: () => void;
  cycleStageTab: (direction: -1 | 1) => void;
  openOverlay: (id: string) => void;
  closeOverlay: () => void;
  openWorkspace: WorkbenchActions["openWorkspace"];
  openFile: WorkbenchActions["openFile"];
  openThread: WorkbenchActions["openThread"];
  setComposerHolds: Dispatch<SetStateAction<number>>;
  setComposerModel: (provider: string, id: string) => Promise<void> | void;
  openInstructions?: () => void;
}

export function useWorkbenchActions(options: UseWorkbenchActionsOptions): WorkbenchActions {
  const setComposerModelRef = useRef(options.setComposerModel);
  setComposerModelRef.current = options.setComposerModel;

  const {
    applyHostResult, client, openPanel, openThread, activeDraftKey, openWorkspace,
    reloadWorkbench, settleActiveThread, snapshot, switchSession, openThreadTree, duplicateThread,
    closeActiveStageTab, cycleStageTab,
  } = options;

  return useMemo<WorkbenchActions>(() => ({
    openPanel,
    openCommandPalette: options.openPalette,
    openSettings: (page) => options.setSettingsPage(page ?? "defaults"),
    newSession: options.openNewThreadPicker,
    switchSession,
    settleActiveThread,
    // Escape is bound to this; only a visibly running thread has anything to stop.
    abort: () => {
      if (options.isVisibleThreadRunning()) {
        void client?.abort(options.threadStore.getSnapshot().activeThreadId || undefined);
      }
    },
    reloadWorkbench,
    openThreadTree,
    duplicateThread,
    focusComposer: (seed) => {
      if (seed !== undefined) options.setComposerSeed(seed);
      options.composerRef.current?.focus();
    },
    focusTranscript: () => {
      (document.querySelector<HTMLElement>(".virtual-transcript")
        ?? options.transcriptRef.current
        ?? (document.querySelector(".transcript-viewport") as HTMLElement | null))?.focus();
    },
    focusStage: () => {
      (document.querySelector(".stage-body, .stage, .stage-container") as HTMLElement | null)?.focus();
    },
    toggleDock: () => { options.setDockOpen((open) => !open); },
    notify: options.setNotice,
    openProjectSources: options.openProjectSources,
    applyHostResult,
    closeActiveStageTab,
    cycleStageTab,
    copyText: async (text: string) => { await options.platform.clipboard.writeText(text); },
    openExternal: (url: string) => options.platform.openExternal(url),
    openOverlay: options.openOverlay,
    closeOverlay: options.closeOverlay,
    compactContext: options.threadCommands.compactContext,
    openModelPicker: () => { window.dispatchEvent(new CustomEvent("tau:open-model-picker")); },
    setModel: async (providerOrQuery: string, id?: string) => {
      if (id) {
        await setComposerModelRef.current(providerOrQuery, id);
        return true;
      }
      const needle = providerOrQuery.toLowerCase();
      const match = options.viewStore.getSnapshot()?.models.find((m) =>
        `${m.provider}/${m.id}`.toLowerCase() === needle ||
        m.id.toLowerCase() === needle ||
        m.name.toLowerCase() === needle ||
        `${m.provider}/${m.id}`.toLowerCase().includes(needle) ||
        m.id.toLowerCase().includes(needle)
      );
      if (match) {
        await setComposerModelRef.current(match.provider, match.id);
        return true;
      }
      return false;
    },
    setThinkingLevel: (level: string) => options.threadCommands.setThinking(level as any),
    openWorkspace,
    activeThread: () => ({
      sessionId: options.pendingNewThread ? undefined : snapshot?.sessionId,
      cwd: options.workspaceCwd,
      workspaceId: options.pendingNewThread?.workspaceId ?? snapshot?.workspaceId,
      model: snapshot?.model,
      ...(snapshot?.backendKind ? { backendKind: snapshot.backendKind } : {}),
      draftPending: options.newThreadDeliveryPending,
    }),
    openFile: options.openFile,
    openThread,
    runShellAction: options.threadCommands.runShellAction,
    holdComposer: () => {
      options.setComposerHolds((count) => count + 1);
      return () => options.setComposerHolds((count) => Math.max(0, count - 1));
    },
    composerDraft: () => activeDraftKey ? options.composerScopeStore.getSnapshot(activeDraftKey).draft : "",
    openInstructions: options.openInstructions ?? (() => { window.dispatchEvent(new CustomEvent("tau:open-instructions")); }),
    copyChat: () => options.threadCommands.copyThreadValue("chat"),
  }), [
    applyHostResult, client, openPanel, openThread, activeDraftKey, openWorkspace,
    reloadWorkbench, settleActiveThread, snapshot, switchSession, openThreadTree, duplicateThread,
    closeActiveStageTab, cycleStageTab,
  ]);
}
