import { useMemo, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { HostSnapshot, UiProject } from "../shared/contracts";
import type { HostActionResult } from "../shared/host-protocol";
import type { HostClient } from "../workbench/host-client";
import type { Platform } from "../workbench/platform";
import type { ThreadStore } from "../workbench/thread-store";
import type { ThreadViewStore } from "../workbench/thread-view-store";
import { allocateAttachmentId, type ComposerScopeStore, type DraftKey } from "../workbench/composer-scope-store";
import { writeComposerDraft } from "../workbench/draft-store";
import type { ThreadCommands } from "../workbench/thread-commands";
import type { NewThreadDraft } from "../workbench/draft-store";
import type { WorkbenchActions } from "./extension-system";
import { errorMessage } from "../workbench/error-message";
import type { PreferencesStore } from "./preferences";
import type { StageTabController } from "./stage-tab-controller";

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
  focusStage: () => void;
  toggleSidebar?: () => void;
  openPanel: (id: string) => void;
  openPalette: () => void;
  setSettingsPage: (page?: string) => void;
  openNewThreadPicker: () => void;
  /** Puts a new thread's draft in a project without the picker. */
  createThreadInProject?: (project: UiProject) => void;
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
  /** Every path that closes a stage tab, and the tabs extensions drew. */
  stageTabs: StageTabController;
  cycleStageTab: (direction: -1 | 1) => void;
  openOverlay: (id: string) => void;
  closeOverlay: () => void;
  openWorkspace: WorkbenchActions["openWorkspace"];
  openFile: WorkbenchActions["openFile"];
  openThread: WorkbenchActions["openThread"];
  setComposerHolds: Dispatch<SetStateAction<number>>;
  setComposerModel: (provider: string, id: string) => Promise<void> | void;
  /** Delivers the model-picker request to the mounted composer. */
  openModelPicker: () => void;
  preferences?: PreferencesStore;
  openInstructions: () => void;
  executeCommand?: (id: string) => Promise<void> | void;
}

export function useWorkbenchActions(options: UseWorkbenchActionsOptions): WorkbenchActions {
  const setComposerModelRef = useRef(options.setComposerModel);
  setComposerModelRef.current = options.setComposerModel;

  const {
    applyHostResult, client, openPanel, openThread, activeDraftKey, openWorkspace,
    reloadWorkbench, settleActiveThread, snapshot, switchSession, openThreadTree, duplicateThread,
    stageTabs, cycleStageTab, openModelPicker, focusStage, openInstructions, toggleSidebar,
  } = options;

  return useMemo<WorkbenchActions>(() => ({
    openPanel,
    openCommandPalette: options.openPalette,
    openSettings: (page) => options.setSettingsPage(page ?? "defaults"),
    newSession: (request?: { workspace?: string }) => {
      const workspace = request?.workspace;
      const project = workspace ? options.threadStore.getProjects().find((candidate) => candidate.workspaceId === workspace || candidate.path === workspace) : undefined;
      if (!workspace) options.openNewThreadPicker();
      else if (project) options.createThreadInProject?.(project);
    },
    switchSession,
    settleActiveThread,
    // Escape is bound to this; only a visibly running thread has anything to stop.
    abort: () => {
      if (options.isVisibleThreadRunning()) {
        void client?.abort(options.threadStore.getSnapshot().activeThreadId || undefined);
      }
    },
    reloadWorkbench,
    openWorkbenchSource: async () => {
      if (!client) return false;
      try {
        const source = await client.workbenchSource();
        return source.path ? openWorkspace(source.path) : false;
      } catch (error) {
        options.setNotice(errorMessage(error));
        return false;
      }
    },
    openThreadTree,
    duplicateThread,
    focusComposer: (seed) => {
      if (seed !== undefined) options.setComposerSeed(seed);
      options.composerRef.current?.focus();
    },
    // The transcript ref is attached to the active, focusable transcript.
    // Keep this action independent of its internal CSS and virtualizer rows.
    focusTranscript: () => { options.transcriptRef.current?.focus(); },
    focusStage,
    toggleDock: () => { options.setDockOpen((open) => !open); },
    ...(toggleSidebar ? { toggleSidebar } : {}),
    notify: options.setNotice,
    openProjectSources: options.openProjectSources,
    applyHostResult,
    closeActiveStageTab: stageTabs.closeActive,
    cycleStageTab,
    openStageTab: stageTabs.open,
    closeStageTab: stageTabs.close,
    stageTabs: stageTabs.tabs,
    activeStageTab: stageTabs.active,
    copyText: async (text: string) => { await options.platform.clipboard.writeText(text); },
    openExternal: (url: string) => options.platform.openExternal(url),
    // Read when called: whether the host's files are this machine's settles after the first render.
    shareFile: async (path: string) => {
      const share = options.platform.files?.shareFile;
      return share ? share(path) : undefined;
    },
    openOverlay: options.openOverlay,
    closeOverlay: options.closeOverlay,
    compactContext: options.threadCommands.compactContext,
    openModelPicker,
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
    toolOutput: options.threadCommands.loadToolOutput,
    holdComposer: () => {
      options.setComposerHolds((count) => count + 1);
      return () => options.setComposerHolds((count) => Math.max(0, count - 1));
    },
    composerDraft: () => activeDraftKey ? options.composerScopeStore.getSnapshot(activeDraftKey).draft : "",
    setComposerDraft: (text: string) => {
      if (activeDraftKey) {
        options.composerScopeStore.setDraft(activeDraftKey, text);
        writeComposerDraft(options.platform.storage, activeDraftKey, text);
      }
      options.setComposerSeed(text);
    },
    composerImages: () => activeDraftKey
      ? options.composerScopeStore.getSnapshot(activeDraftKey).attachments.map(({ id: _id, previewUrl: _url, ...image }) => image)
      : [],
    setComposerImages: (images) => {
      if (!activeDraftKey) return;
      options.composerScopeStore.setAttachments(activeDraftKey, images.map((image) => ({
        ...image, id: allocateAttachmentId(), previewUrl: `data:${image.mimeType};base64,${image.data}`,
      })));
    },
    openPromptEditor: async () => {
      if (!client) return;
      try {
        const current = activeDraftKey ? options.composerScopeStore.getSnapshot(activeDraftKey).draft : "";
        const result = await client.openExternalEditor(current);
        if (result?.modified) {
          if (activeDraftKey) {
            options.composerScopeStore.setDraft(activeDraftKey, result.text);
          }
          options.setComposerSeed(result.text);
          options.setNotice("Draft updated from external editor.");
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        options.setNotice(msg);
      }
    },
    openInstructions,
    executeCommand: options.executeCommand,
    copyChat: () => options.threadCommands.copyThreadValue("chat"),
    renameThread: options.threadCommands.renameThread,
    cycleModel: async (direction: 1 | -1 = 1) => {
      const snap = options.viewStore.getSnapshot();
      const allModels = snap?.models ?? [];
      if (allModels.length === 0) return false;

      const favKeys = options.preferences?.getSnapshot().favouriteModels ?? [];
      const scopedModels = favKeys.length > 0
        ? favKeys
            .map((key) => {
              const slash = key.indexOf("/");
              if (slash === -1) return undefined;
              const provider = key.slice(0, slash);
              const id = key.slice(slash + 1);
              return allModels.find((m) => m.provider === provider && m.id === id);
            })
            .filter((m): m is NonNullable<typeof m> => Boolean(m))
        : allModels;

      const models = scopedModels.length > 0 ? scopedModels : allModels;
      const current = snap?.model;
      const currentIndex = current ? models.findIndex((m) => m.provider === current.provider && m.id === current.id) : -1;
      const nextIndex = (currentIndex + direction + models.length) % models.length;
      const next = models[nextIndex];
      if (next) {
        await setComposerModelRef.current(next.provider, next.id);
        return true;
      }
      return false;
    },
    cycleThinking: async () => {
      const snap = options.viewStore.getSnapshot();
      const levels = snap?.thinkingLevels ?? ["off", "minimal", "low", "medium", "high", "max"];
      const current = snap?.thinkingLevel ?? "off";
      const currentIndex = levels.indexOf(current);
      const nextIndex = (currentIndex + 1) % levels.length;
      const next = levels[nextIndex];
      if (next) {
        await options.threadCommands.setThinking(next as any);
      }
    },
  }), [
    applyHostResult, client, openPanel, openThread, activeDraftKey, openWorkspace,
    reloadWorkbench, settleActiveThread, snapshot, switchSession, openThreadTree, duplicateThread,
    stageTabs, cycleStageTab, openModelPicker, focusStage, openInstructions, toggleSidebar,
  ]);
}
