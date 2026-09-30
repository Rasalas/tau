import { useMemo, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { HostSnapshot, UiProject } from "../shared/contracts";
import type { HostActionResult } from "../shared/host-protocol";
import type { HostClient } from "../workbench/host-client";
import type { Platform } from "../workbench/platform";
import type { ThreadStore } from "../workbench/thread-store";
import type { ThreadViewStore } from "../workbench/thread-view-store";
import type { ToastStore } from "../workbench/toast-store";
import { allocateAttachmentId, type ComposerScopeStore, type DraftKey } from "../workbench/composer-scope-store";
import { writeComposerDraft } from "../workbench/draft-store";
import type { ThreadCommands } from "../workbench/thread-commands";
import type { NewThreadDraft } from "../workbench/draft-store";
import type { WorkbenchActions } from "./extension-system";
import { errorMessage } from "../workbench/error-message";
import type { PreferencesStore } from "./preferences";
import type { StageTabController } from "./stage-tab-controller";
import { effectiveNewThreadRuntime } from "./new-thread-runtime";
import { newThreadProject } from "../workbench/new-thread-project";
import { namesWorkspace } from "../shared/workspace-identity";
import { isFilesystemRoot } from "../shared/filesystem-root";
import type { NewThreadPick } from "./use-app-overlays";
import { offeringKey } from "./components/model-offerings";
import type { NewThreadController } from "../workbench/new-thread-controller";
import type { AppPageStore } from "../workbench/app-page-store";
import { withAppPages } from "./app-page-actions";

export interface UseWorkbenchActionsOptions {
  client: HostClient | undefined;
  platform: Platform;
  threadStore: ThreadStore;
  viewStore: ThreadViewStore;
  /** Absent in a slice rendered without a workbench session; `toast` is absent with it. */
  toasts?: ToastStore;
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
  /** Brings the chat into view (out of a maximized stage, a sheet); with `focusComposer`, the composer takes the keyboard once drawn. */
  showThread?: (options: { focusComposer: true }) => void;
  toggleSidebar?: () => void;
  openPanel: (id: string) => void;
  closePanel?: (id: string) => void;
  togglePanelMaximized?: () => void;
  openPalette: (options?: { menu?: string }) => void;
  setSettingsPage: (page?: string) => void;
  openNewThreadPicker: (pick?: NewThreadPick) => void;
  /** Puts a new thread's draft in a project without the picker. */
  createThreadInProject?: (project: UiProject) => void;
  switchSession: WorkbenchActions["switchSession"];
  openDraft?: WorkbenchActions["openDraft"];
  discardDraft?: WorkbenchActions["discardDraft"];
  settleActiveThread: () => void;
  isVisibleThreadRunning: () => boolean;
  reloadWorkbench: WorkbenchActions["reloadWorkbench"];
  openThreadTree: WorkbenchActions["openThreadTree"];
  duplicateThread: WorkbenchActions["duplicateThread"];
  setComposerSeed: (seed: string) => void;
  setDockOpen: Dispatch<SetStateAction<boolean>>;
  setNotice: (notice: any) => void;
  openProjectSources: (source?: string) => void;
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
  setComposerMode?: (mode: string) => Promise<boolean>;
  /** Sends the oldest queued message of the thread on screen now; false without one. */
  steerQueuedMessage?: () => boolean;
  /** Runs before a stop, which hands the queue back to the composer. */
  beforeAbort?: () => void;
  submitPrompt?: (text: string) => Promise<{ accepted: boolean }>;
  /** Delivers the model-picker request to the mounted composer. */
  openModelPicker: () => void;
  preferences?: PreferencesStore;
  openInstructions: () => void;
  executeCommand?: (id: string) => Promise<void> | void;
  attachFiles?: WorkbenchActions["attachFiles"];
  /** Binds the draft on screen to another runtime; it keeps what it chose for each. */
  selectDraftRuntime?: (kind: string) => void;
  /** The draft's model for `runtime`, and the model the next draft starts on. */
  newThreadController?: Pick<NewThreadController, "carryToNextDraft" | "setModel">;
  /** The app page on screen; without it, `openPage` is absent. */
  pages?: AppPageStore;
  /** Whether something covers the thread, and a compact client's list order; read when asked. */
  threadView?: () => { covered: boolean; listOrder?: readonly string[] } | undefined;
}

export function useWorkbenchActions(options: UseWorkbenchActionsOptions): WorkbenchActions {
  const setComposerModelRef = useRef(options.setComposerModel);
  setComposerModelRef.current = options.setComposerModel;
  // A draft's model changes without a new draft key, so it is read when asked.
  const pendingNewThreadRef = useRef(options.pendingNewThread);
  pendingNewThreadRef.current = options.pendingNewThread;

  const {
    applyHostResult, client, openPanel, openThread, activeDraftKey, openWorkspace,
    reloadWorkbench, settleActiveThread, snapshot, switchSession, openThreadTree, duplicateThread,
    stageTabs, cycleStageTab, openModelPicker, focusStage, openInstructions, toggleSidebar,
  } = options;

  return useMemo<WorkbenchActions>(() => {
    // `unlisted`: a project the window does not list yet is chosen in the picker.
    const newSession = (request?: { workspace?: string; pick?: boolean }, unlisted = false) => {
      const workspace = request?.workspace;
      const projects = options.threadStore.getProjects();
      const named = workspace ? projects.find((candidate) => namesWorkspace(workspace, candidate.workspaceId, candidate.path)) : undefined;
      // A caller that names the project starts there: a settled thread's, a machine's.
      if (workspace && !request.pick) {
        if (named) options.createThreadInProject?.(named);
        else if (unlisted) options.openNewThreadPicker();
        return;
      }
      // Nothing to choose from yet: adding a project comes first (design 2a); with one, only `pick` asks.
      const choices = projects.filter((project) => !isFilesystemRoot(project.path));
      if (choices.length === 0) { options.openProjectSources(); return; }
      if (choices.length === 1 && !request?.pick) { options.createThreadInProject?.(choices[0]!); return; }
      const draft = pendingNewThreadRef.current;
      const thread = options.viewStore.getSnapshot();
      // Otherwise it asks, with the project in context first: the named one, else the one on screen.
      const context = named ?? newThreadProject(projects, options.threadStore.getSnapshot().threads, {
        covered: Boolean(options.threadView?.()?.covered), ...(draft ? { draft } : {}), ...(thread ? { thread } : {}),
      });
      options.openNewThreadPicker(context ? { preselect: context.workspaceId ?? context.path } : undefined);
    };
    const actions: WorkbenchActions = {
      openPanel,
      ...(options.closePanel ? { closePanel: options.closePanel } : {}),
      ...(options.togglePanelMaximized ? { togglePanelMaximized: options.togglePanelMaximized } : {}),
      openCommandPalette: options.openPalette,
      openSettings: (page) => options.setSettingsPage(page ?? "general"),
      // Read what is on screen first: Settings covers the thread until the next render.
      newSession: (request) => { newSession(request); options.setSettingsPage(undefined); },
      switchSession,
      ...(options.openDraft ? { openDraft: options.openDraft } : {}),
      ...(options.discardDraft ? { discardDraft: options.discardDraft } : {}),
      settleActiveThread,
      // Escape is bound to this; only a visibly running thread has anything to stop.
      abort: () => {
        if (options.isVisibleThreadRunning()) {
          options.beforeAbort?.();
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
        const composer = options.composerRef.current;
        composer?.focus();
        // A folded chat (a maximized stage) cannot take it: show the chat, then the composer takes it.
        if (composer && document.activeElement !== composer) options.showThread?.({ focusComposer: true });
      },
      // The transcript ref is attached to the active, focusable transcript.
      // Keep this action independent of its internal CSS and virtualizer rows.
      focusTranscript: () => { options.transcriptRef.current?.focus(); },
      focusStage,
      toggleDock: () => { options.setDockOpen((open) => !open); },
      ...(toggleSidebar ? { toggleSidebar } : {}),
      notify: options.setNotice,
      ...(options.toasts ? { toast: options.toasts.show } : {}),
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
      ...(options.setComposerMode ? { setMode: options.setComposerMode } : {}),
      ...(options.steerQueuedMessage ? { steerQueuedMessage: options.steerQueuedMessage } : {}),
      ...(options.submitPrompt ? { submitPrompt: async (text: string) => (await options.submitPrompt!(text)).accepted } : {}),
      openWorkspace,
      activeThread: () => {
        const pending = pendingNewThreadRef.current;
        const covered = options.threadView?.()?.covered ? { covered: true } : {};
        if (!pending) {
          return {
            ...covered,
            sessionId: snapshot?.sessionId,
            cwd: options.workspaceCwd,
            workspaceId: snapshot?.workspaceId,
            model: snapshot?.model,
            ...(snapshot?.backendKind ? { backendKind: snapshot.backendKind } : {}),
            mode: snapshot?.mode ?? "default",
            modes: snapshot?.modes ?? [],
            draftPending: options.newThreadDeliveryPending,
          };
        }
        // A draft starts on its own runtime and model, not on the last thread's.
        const backendKind = effectiveNewThreadRuntime(pending.runtime ?? options.preferences?.getSnapshot().newThreadRuntime, snapshot);
        const inherited = backendKind === "pi" && (snapshot?.backendKind ?? "pi") === "pi" ? snapshot?.model : undefined;
        const model = pending.model ?? inherited;
        return {
          ...covered,
          cwd: options.workspaceCwd,
          ...(pending.workspaceId ? { workspaceId: pending.workspaceId } : {}),
          ...(model ? { model: { provider: model.provider, id: model.id } } : {}),
          backendKind,
          mode: pending.mode ?? "default",
          modes: snapshot?.runtimeBackends?.find((backend) => backend.kind === backendKind)?.modes ?? [],
          draftPending: options.newThreadDeliveryPending,
        };
      },
      threadListOrder: () => options.threadView?.()?.listOrder,
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
          const msg = errorMessage(error);
          options.setNotice(msg);
        }
      },
      openInstructions,
      executeCommand: options.executeCommand,
      copyChat: () => options.threadCommands.copyThreadValue("chat"),
      renameThread: options.threadCommands.renameThread,
      ...(options.attachFiles ? { attachFiles: options.attachFiles } : {}),
      cycleModel: async (direction: 1 | -1 = 1) => {
        const snap = options.viewStore.getSnapshot();
        const allModels = snap?.models ?? [];
        if (allModels.length === 0) return false;

        // Favourites of this thread's runtime, in the order they were starred.
        const favKeys = options.preferences?.getSnapshot().favouriteModels ?? [];
        const byKey = new Map(allModels.map((model) => [offeringKey(snap?.backendKind, model), model] as const));
        const scopedModels = favKeys.length > 0
          ? favKeys.flatMap((key) => { const model = byKey.get(key); return model ? [model] : []; })
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
      runtimeModels: async () => (await import("./runtime-models")).listRuntimeModels(
        client, snapshot?.runtimeBackends, pendingNewThreadRef.current ? undefined : options.viewStore.getSnapshot(),
      ),
      startThreadOn: (runtime, model) => {
        const controller = options.newThreadController;
        if (pendingNewThreadRef.current) {
          options.selectDraftRuntime?.(runtime);
          if (model) void controller?.setModel(model.provider, model.id, undefined, () => model.name, runtime);
          return;
        }
        controller?.carryToNextDraft(runtime, model);
        options.preferences?.setNewThreadRuntime(runtime);
        // In the project on screen, as the model picker's new thread.
        const workspace = snapshot?.workspaceId ?? options.workspaceCwd;
        newSession(workspace ? { workspace } : undefined, true);
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
    };
    return options.pages ? withAppPages(actions, options.pages, () => options.setSettingsPage(undefined)) : actions;
  }, [
    applyHostResult, client, openPanel, openThread, activeDraftKey, openWorkspace,
    reloadWorkbench, settleActiveThread, snapshot, switchSession, openThreadTree, duplicateThread,
    stageTabs, cycleStageTab, openModelPicker, focusStage, openInstructions, toggleSidebar, options.attachFiles, options.pages,
    options.openDraft, options.discardDraft,
  ]);
}
