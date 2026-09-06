import { lazy } from "react";
import { HostUnavailableError, type DesktopExtension, type DesktopExtensionContext, type WorkbenchActions } from "../extension-system";
import { errorMessage } from "../error-message";
import { getHostClient } from "../host-client-context";
import type { PiKeybindingsState, PiShortcutsState } from "../../shared/keybindings-protocol";

// Keep optional extension UI out of the workbench's first renderer chunk. The
// registry still owns activation; React loads a contribution when its slot is
// actually rendered.
const LazyChangesPanel = lazy(() => import("./workspace-panels").then(({ ChangesPanel }) => ({ default: ChangesPanel })));
const LazyFilesPanel = lazy(() => import("./workspace-panels").then(({ FilesPanel }) => ({ default: FilesPanel })));
const LazyPreviewPanel = lazy(() => import("./preview-panel").then(({ PreviewPanel }) => ({ default: PreviewPanel })));
const LazyCloneProjectSource = lazy(() => import("./project-navigation").then(({ CloneProjectSource }) => ({ default: CloneProjectSource })));
const LazyLocalFolderSource = lazy(() => import("./project-navigation").then(({ LocalFolderSource }) => ({ default: LocalFolderSource })));
const LazyWorkspaceSidebar = lazy(() => import("./project-navigation").then(({ WorkspaceSidebar }) => ({ default: WorkspaceSidebar })));
import { accessKitExtension } from "./access-kit";
import { claudeCodeExtension } from "./claude-code-kit";
import { workspaceKit } from "./workspace-kit-client";
import { registerCheckpoints } from "./workspace-checkpoints";
import { TurnChangesDock, WorkspaceBarControl, WorkspaceFollower } from "./workspace-dock";
import { WorkspaceTitleActions } from "./workspace-title";
import { ReviewOverlay, REVIEW_OVERLAY } from "./review-overlay";
import type { WorkspaceStore } from "./workspace-store";
import { serviceTierKitExtension } from "./service-tier-kit";
import { agentsExtension } from "./agents-kit";
import { piUiExtension } from "./pi-ui";
import { PREVIEW_PANEL, PreviewFollower, isPreviewState, previewKit, previewStore } from "./preview-store";
import { PREVIEW_HOST_EXTENSION_ID, PREVIEW_STATE_EVENT } from "../../shared/preview-protocol";
import { packagesExtension } from "./packages-kit";
import { questionnaireExtension } from "./questionnaire-kit";
import { COMMIT_MESSAGE_OPTIONS, registerCommitMessages } from "./commit-messages";

let lastDocumentState: { changes: import("../../shared/workspace-kit-types").UiWorkspaceChanges; editor?: import("../../shared/workspace-kit-types").UiEditor } | undefined;
let lastDocumentInputs: [unknown, unknown, string | undefined] | undefined;
/** Stable object per (changes, editors, editor preference) so the stage's store snapshot does not churn. */
function documentState(workspaceStore: WorkspaceStore) {
  const state = workspaceStore.getSnapshot();
  const editor = workspaceStore.activeEditor();
  const inputs: [unknown, unknown, string | undefined] = [state.changes, state.editors, editor?.id];
  if (!lastDocumentState || !lastDocumentInputs || lastDocumentInputs.some((value, index) => value !== inputs[index])) {
    lastDocumentInputs = inputs;
    lastDocumentState = { changes: state.changes, editor };
  }
  return lastDocumentState;
}

export const workspaceExtension: DesktopExtension = {
  id: "tau.workspace",
  name: "Workspace Kit",
  activate(plugin) {
    const workspaceStore = plugin.workspaceStore;
    plugin.registerSidebar({ id: "workspace.sidebar", order: 10, Component: LazyWorkspaceSidebar });
    plugin.registerProjectSource({
      id: "workspace.local-folder",
      label: "Local folder",
      description: "Open an existing checkout or any folder on this Mac.",
      glyph: "▱",
      order: 10,
      Component: LazyLocalFolderSource,
    });
    plugin.registerProjectSource({
      id: "workspace.git-clone",
      label: "Clone Git repository",
      description: "Clone an HTTPS or SSH URL, then open it as a project.",
      glyph: "⌘",
      order: 20,
      Component: LazyCloneProjectSource,
    });
    plugin.registerPanel({ id: "files", label: "Files", glyph: "files", order: 10, Component: LazyFilesPanel });
    // Transcript checkpoint cards and their historical review belong to the
    // workspace contribution. Removing Workspace Kit therefore removes both
    // the card and its diff surface without App knowing their implementation.
    // The kit owns its workspace state; these keep it following the workbench
    // and place its controls where core lends room.
    plugin.registerRegion({ id: "workspace.follower", placement: "composer-above", order: 0, Component: WorkspaceFollower });
    plugin.registerRegion({ id: "workspace.title-actions", placement: "title-bar", order: 10, Component: WorkspaceTitleActions });
    plugin.registerRegion({ id: "workspace.turn-changes", placement: "transcript-footer", order: 10, Component: TurnChangesDock });
    plugin.registerComposerControl({ id: "workspace.bar", placement: "footer", order: 10, Component: WorkspaceBarControl });
    plugin.registerDocumentSource({
      id: "workspace.documents",
      loadFile: (relPath) => workspaceKit.readFile(relPath),
      loadDiff: (relPath, options) => workspaceKit.getFileDiff(relPath, options),
      openInEditor: (relPath) => void workspaceStore.openInEditor(relPath),
      getState: () => documentState(workspaceStore),
      subscribe: workspaceStore.subscribe,
    });
    plugin.events.on("user-message", (event) => workspaceStore.turnStarted(event.sessionId));
    plugin.events.on("agent-status", (event) => { if (!event.running) workspaceStore.turnSettled(event.sessionId); });
    plugin.events.on("tool-end", (event) => workspaceStore.toolFinished(event.tool));
    registerCheckpoints(plugin);
    plugin.registerOptions([
      { id: "group-by-project", kind: "toggle", label: "Group threads by project instead of recency", defaultValue: false },
      { id: "show-settled", kind: "toggle", label: "Show settled shelf", defaultValue: true },
      { id: "compact-rows", kind: "toggle", label: "Compact rows in the thread rail", defaultValue: false },
      { id: "sources", kind: "chips", label: "Add-project sources", values: ["local folder", "git clone"] },
    ]);
    plugin.registerCommand({ id: "workspace.files", label: "Open file index", group: "Project", run: (app) => app.openPanel("files") });
    plugin.registerCommand({ id: "workspace.open-project", label: "Open project…", group: "Project", run: async (app) => {
      try {
        const picked = await workspaceKit.pickFolder();
        if (picked) await app.openWorkspace(picked.workspaceId);
      } catch (error) {
        app.notify(error instanceof Error ? error.message : String(error));
      }
    } });
    plugin.registerCommand({ id: "workspace.settle", label: "Settle thread", group: "Thread", run: (app) => app.settleActiveThread() });
    // The branch is the kit's fact; the title menu only lends the slot.
    plugin.registerCommand({ id: "workspace.copy-branch", label: "Copy branch", group: "Thread", surfaces: ["thread-title"], run: async (app) => {
      const branch = workspaceStore.getSnapshot().workspace?.branch;
      if (!branch) { app.notify("Branch is unavailable."); return; }
      try { await getHostClient()?.copyText(branch); app.notify("Branch copied."); } catch (error) { app.notify(error instanceof Error ? error.message : String(error)); }
    } });
    plugin.registerKeybinding({ keys: "mod+p", commandId: "workspace.open-project" });
    plugin.registerKeybinding({ keys: "mod+shift+s", commandId: "workspace.settle" });
    plugin.registerToolRenderer(
      "workspace.read-renderer",
      (tool) => tool.name === "read" || tool.name === "grep" || tool.name === "find" || tool.name === "ls",
      (tool) => ({
        glyph: "→",
        title: tool.name,
        tone: "read",
        detail: String(tool.args.path ?? tool.args.pattern ?? tool.args.query ?? "workspace"),
      }),
    );
    plugin.registerToolRenderer(
      "workspace.write-renderer",
      (tool) => tool.name === "edit" || tool.name === "write",
      (tool) => ({
        glyph: "±",
        title: tool.name,
        tone: "write",
        detail: String(tool.args.path ?? "file mutation"),
      }),
    );
  },
};

export const reviewExtension: DesktopExtension = {
  id: "tau.review",
  name: "Review Kit",
  activate(plugin) {
    plugin.registerPanel({ id: "changes", label: "Changes", glyph: "changes", order: 20, Component: LazyChangesPanel });
    plugin.registerOverlay({ id: REVIEW_OVERLAY, Component: ReviewOverlay });
    plugin.registerOptions([
      { id: "split-diff", kind: "toggle", label: "Open diffs in split view", defaultValue: false },
      ...COMMIT_MESSAGE_OPTIONS,
    ]);
    const disposeCommitMessages = registerCommitMessages(plugin);
    plugin.registerCommand({ id: "review.open", label: "Review changes", group: "Project", run: () => plugin.workspaceStore.openReview() });
    plugin.registerKeybinding({ keys: "mod+shift+d", commandId: "review.open" });
    plugin.registerCommand({ id: "review.changes", label: "Inspect Git changes", group: "Project", run: (app) => app.openPanel("changes") });
    return disposeCommitMessages;
  },
};

/**
 * Tau's chords for the runtime commands, and the Pi action whose entry in
 * `~/.pi/agent/keybindings.json` replaces each of them when the user set one.
 */
const RUNTIME_KEYBINDINGS: ReadonlyArray<{ commandId: string; keys?: string; piAction?: string }> = [
  { commandId: "runtime.command-palette", keys: "mod+k" },
  { commandId: "runtime.new-session", keys: "mod+n", piAction: "app.session.new" },
  { commandId: "runtime.abort", keys: "escape", piAction: "app.interrupt" },
  { commandId: "runtime.model", piAction: "app.model.select" },
  { commandId: "runtime.toggle-thinking", piAction: "app.thinking.toggle" },
];

// No host, or a host without this extension's entry (safe mode): Tau's chords stay.
const ignoreHostUnavailable = (error: unknown) => {
  if (error instanceof HostUnavailableError || /is not installed/u.test(errorMessage(error))) return;
  console.warn("Pi keybindings are unavailable", error);
};

function bindRuntimeKeys(plugin: DesktopExtensionContext, isDisposed: () => boolean): void {
  const defaults = new Map<string, () => void>();
  for (const entry of RUNTIME_KEYBINDINGS) {
    if (entry.keys) defaults.set(entry.commandId, plugin.registerKeybinding({ keys: entry.keys, commandId: entry.commandId }));
  }
  void plugin.host.invoke("pi-keybindings").then((state) => {
    if (isDisposed()) return;
    const bindings = (state as PiKeybindingsState).bindings;
    for (const entry of RUNTIME_KEYBINDINGS) {
      const keys = entry.piAction ? bindings[entry.piAction] : undefined;
      if (!keys?.length) continue;
      defaults.get(entry.commandId)?.();
      for (const chord of keys) {
        try { plugin.registerKeybinding({ keys: chord, commandId: entry.commandId }); } catch (error) { console.warn(`keybindings.json: ${entry.piAction} = ${chord} is not a chord Tau understands`, error); }
      }
    }
  }).catch(ignoreHostUnavailable);
}

/** Shortcuts Pi extensions registered: a palette command each, bound to the same chord. */
function bindPiShortcuts(plugin: DesktopExtensionContext, isDisposed: () => boolean): () => void {
  let disposers: Array<() => void> = [];
  const clear = () => { disposers.forEach((dispose) => dispose()); disposers = []; };
  const refresh = (sessionId?: string) => plugin.host.invoke("shortcuts", sessionId ? { sessionId } : undefined).then((state) => {
    if (isDisposed()) return;
    clear();
    for (const shortcut of (state as PiShortcutsState).shortcuts) {
      const id = `pi.shortcut.${shortcut.keys}`;
      try {
        disposers.push(plugin.registerCommand({
          id,
          label: shortcut.description ?? `Pi shortcut ${shortcut.keys}`,
          group: "Pi",
          run: async (app) => {
            try { await plugin.host.invoke("run-shortcut", { keys: shortcut.keys, sessionId: app.activeThread()?.sessionId }); } catch (error) { app.notify(errorMessage(error)); }
          },
        }));
        disposers.push(plugin.registerKeybinding({ keys: shortcut.keys, commandId: id }));
      } catch (error) {
        console.warn(`Pi shortcut ${shortcut.keys} from ${shortcut.source} could not be bound`, error);
      }
    }
  }).catch(ignoreHostUnavailable);
  void refresh();
  plugin.events.on("active-thread-changed", (event) => void refresh(event.sessionId));
  return clear;
}

/**
 * Preview Kit: a browser panel the host draws over, and the tools that let the
 * agent open, read and drive the page it just changed.
 */
export const previewExtension: DesktopExtension = {
  id: PREVIEW_HOST_EXTENSION_ID,
  name: "Preview",
  activate(plugin) {
    plugin.registerPanel({ id: PREVIEW_PANEL, label: "Preview", glyph: "preview", order: 40, Component: LazyPreviewPanel });
    plugin.registerRegion({ id: "preview.follower", placement: "composer-above", order: 60, Component: PreviewFollower });
    plugin.host.onEvent(PREVIEW_STATE_EVENT, (payload) => { if (isPreviewState(payload)) previewStore.set(payload); });
    const open = async (url: string, app: WorkbenchActions): Promise<string | undefined> => {
      app.openPanel(PREVIEW_PANEL);
      if (!url) return undefined;
      try {
        await previewKit.open({ url });
      } catch (error) {
        return errorMessage(error);
      }
      return undefined;
    };
    plugin.registerCommand({ id: "preview.open", label: "Open preview panel", group: "Extensions", run: (app) => { void open("", app); } });
    plugin.registerSlashCommand({
      name: "preview",
      description: "Open a URL in the preview panel",
      argumentHint: "<url>",
      run: (args, app) => open(args.trim(), app),
    });
    plugin.registerKeybinding({ keys: "mod+shift+b", commandId: "preview.open" });
  },
};

export const settingsExtension: DesktopExtension = {
  id: "tau.runtime-settings",
  name: "Runtime Controls",
  activate(plugin) {
    plugin.registerCommand({ id: "runtime.settings", label: "Open Settings panel", group: "Runtime", run: (app) => app.openSettings() });
    plugin.registerCommand({ id: "runtime.model", label: "Set model…", group: "Runtime", run: (app) => app.openSettings("defaults") });
    plugin.registerCommand({ id: "runtime.thinking", label: "Set thinking level…", group: "Thread", run: (app) => app.openSettings("defaults") });
    plugin.registerCommand({ id: "runtime.new-session", label: "Create new thread", group: "Thread", run: (app) => app.newSession() });
    plugin.registerCommand({ id: "runtime.toggle-thinking", label: "Expand or collapse thinking blocks", group: "Thread", run: () => plugin.preferences.setShowThinking(!plugin.preferences.getSnapshot().showThinking) });
    plugin.registerCommand({ id: "runtime.abort", label: "Stop the run", group: "Runtime", run: (app) => app.abort() });
    plugin.registerCommand({ id: "runtime.command-palette", label: "Open command palette", group: "Runtime", run: (app) => app.openCommandPalette() });
    plugin.registerCommand({ id: "runtime.thread-tree", label: "Thread tree…", group: "Thread", run: (app) => app.openThreadTree("navigate") });
    plugin.registerCommand({ id: "runtime.fork-thread", label: "Fork thread…", group: "Thread", run: (app) => app.openThreadTree("fork") });
    plugin.registerCommand({ id: "runtime.duplicate-thread", label: "Duplicate thread", group: "Thread", run: async (app) => { await app.duplicateThread(); } });
    plugin.registerCommand({ id: "runtime.reload", label: "Apply changes and reload Tau", group: "Runtime", run: async (app) => { await app.reloadWorkbench(); } });
    plugin.registerSlashCommand({ name: "reload", description: "Apply source and extension changes, then reload Tau", run: async (_args, app) => (await app.reloadWorkbench()) ? undefined : "Tau reload failed." });
    plugin.registerSlashCommand({ name: "tree", description: "Move this thread to another point of its session tree", run: (_args, app) => app.openThreadTree("navigate") });
    plugin.registerSlashCommand({ name: "fork", description: "Start a new thread from an earlier message", run: (_args, app) => app.openThreadTree("fork") });
    plugin.registerSlashCommand({ name: "clone", description: "Duplicate this thread into a new one", run: async (_args, app) => (await app.duplicateThread()) ? undefined : "The thread could not be duplicated." });
    let disposed = false;
    bindRuntimeKeys(plugin, () => disposed);
    const clearShortcuts = bindPiShortcuts(plugin, () => disposed);
    return () => { disposed = true; clearShortcuts(); };
  },
};

export const bundledExtensions = [
  accessKitExtension,
  serviceTierKitExtension,
  workspaceExtension,
  reviewExtension,
  agentsExtension,
  piUiExtension,
  previewExtension,
  questionnaireExtension,
  packagesExtension,
  settingsExtension,
  claudeCodeExtension,
];
