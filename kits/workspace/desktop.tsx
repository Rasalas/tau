import { useEffect } from "react";
import { Folder, GitBranch, GitCompare, HardDrive } from "lucide-react";
import {
  THREAD_BRANCH_SERVICE,
  errorMessage,
  hostHasLocalFiles,
  type DesktopExtension,
  type FileNode,
  type PanelProps,
  type UiEditor,
  type UiWorkspaceChanges,
} from "tau";
import {
  CLONE_PROGRESS_EVENT,
  createWorkspaceHostClient,
  WORKSPACE_CHANGES_PANEL,
  WORKSPACE_FILES_PANEL,
  WORKSPACE_HOST_EXTENSION_ID,
  WORKSPACE_STORE_SERVICE,
} from "./protocol.js";
import { addProjectMenu } from "./add-project-menu.js";
import { threadBranchService } from "./branch-service.js";
import { registerCheckpoints } from "./checkpoints.js";
import { WorkspaceFollower } from "./dock.js";
import { createDraftBranchPill, ThreadBranch, WorktreeSuggestionPill } from "./branch-menu.js";
import { CloneProjectSource, LocalFolderSource, requestProjectSwitcher, WorkspaceSidebar } from "./navigation.js";
import { ChangesPanel, FilesPanel, SEARCH_FILES_SERVICE, serviceSlot, type SearchFilesService } from "./panels.js";
import { NEW_THREAD_WORKSPACE_KEY, START_FROM_ORIGIN_OPTION, WorkspaceStore } from "./store.js";
import { withWorkspaceStore } from "./store-context.js";
import { RAIL_ORDER_OPTIONS } from "./rail-order.js";
import { publishProjectIcons } from "./project-icons.js";
import { WorkspaceEditorButton, WorkspaceTitleActions } from "./title.js";
import { createStoragePage, STORAGE_SETTINGS_ROWS } from "./storage-page.js";
import { OPEN_REQUEST_EVENT, OPEN_REQUEST_WAITING_COMMAND, STORAGE_CHANGED_EVENT, TAKE_OPEN_REQUEST_COMMAND, type WorktreeStorageHostCommands } from "./storage-protocol.js";
import { OpenRequests } from "./open-requests.js";
import { SOURCE_CONTROL_SETTINGS_ROWS, SourceControlPage } from "./source-control-page.js";

/** No need to poll every 30 s; a tick, a focus and a project switch are enough here. */
const AUTO_PULL_INTERVAL_MS = 5 * 60_000;

/** Stable object per (changes, editors, editor preference) so the stage's store snapshot does not churn. */
function documentStates(store: WorkspaceStore): () => { changes: UiWorkspaceChanges; editor?: UiEditor } {
  let last: { changes: UiWorkspaceChanges; editor?: UiEditor } | undefined;
  let inputs: [unknown, unknown, string | undefined] | undefined;
  return () => {
    const state = store.getSnapshot();
    // An editor of the host's machine is no use to a client whose files are elsewhere (a phone, a tablet).
    const editor = hostHasLocalFiles() ? store.activeEditor() : undefined;
    const next: [unknown, unknown, string | undefined] = [state.changes, state.editors, editor?.id];
    if (!last || !inputs || inputs.some((value, index) => value !== next[index])) {
      inputs = next;
      last = { changes: state.changes, editor };
    }
    return last;
  };
}

/**
 * Workspace Kit's desktop half: the thread rail, the project sources, the
 * Files and Changes panels, the title-bar controls, the worktree bar and the
 * turn checkpoints. Everything reads one store, which the kit creates here and
 * publishes for the kits built on it (Review, Worktree Names).
 */
export const workspaceExtension: DesktopExtension = {
  id: WORKSPACE_HOST_EXTENSION_ID,
  name: "Workspace Kit",
  activate(context) {
    const host = createWorkspaceHostClient((command, input) => context.host.invoke(command, input));
    const store = new WorkspaceStore(context.preferences, host);
    const bind = <P extends object>(Component: Parameters<typeof withWorkspaceStore<P>>[1]) => withWorkspaceStore(store, Component);
    context.provideService(WORKSPACE_STORE_SERVICE, store);
    // The branch on screen, for any package: a public contract, unlike the store.
    context.provideService(THREAD_BRANCH_SERVICE, threadBranchService(store));
    // Pill, picker, phone list and Reviews draw the icon chosen in Project settings too.
    const unpublishIcons = publishProjectIcons(context.preferences, (icons) => context.setProjectIcons?.(icons));

    context.registerSidebar({ id: "workspace.sidebar", order: 10, profiles: ["desktop"], Component: bind(WorkspaceSidebar) });
    context.registerProjectSource({
      id: "workspace.local-folder",
      label: "Local folder",
      profiles: ["desktop"],
      description: "Open an existing checkout or any folder on this Mac.",
      glyph: "▱",
      order: 10,
      Component: bind(LocalFolderSource),
    });
    context.registerProjectSource({
      id: "workspace.git-clone",
      label: "Clone Git repository",
      profiles: ["desktop"],
      description: "Clone an HTTPS or SSH URL, then open it as a project.",
      glyph: "⌘",
      order: 20,
      Component: bind(CloneProjectSource),
    });
    // Search Kit's "Go to file", when it is there, gets a button in the Files panel.
    const search = serviceSlot<SearchFilesService>();
    context.useService<SearchFilesService>(SEARCH_FILES_SERVICE, (service) => {
      search.set(service);
      return () => { if (search.get() === service) search.set(undefined); };
    });
    const FilesPanelWithSearch = (props: PanelProps) => <FilesPanel {...props} search={search} />;
    context.registerPanel({
      id: WORKSPACE_FILES_PANEL, label: "Files", Icon: Folder, order: 10, maximizable: true, stageButton: true, profiles: ["desktop", "compact"],
      Component: bind(FilesPanelWithSearch),
    });
    // The Changes panel reads the same Git state as the rest of the kit, so it
    // travels with it. Where a kit draws the review, the entry opens that instead.
    context.registerPanel({
      id: WORKSPACE_CHANGES_PANEL, label: "Changes", Icon: GitCompare, order: 20, maximizable: true, profiles: ["desktop"],
      redirect: () => store.openChangesView(), Component: bind(ChangesPanel),
    });
    // The kit owns its workspace state; these keep it following the workbench
    // and place its controls where core lends room.
    // A phone or tablet follows too: its Files panel and documents read the thread's project.
    context.registerRegion({ id: "workspace.follower", placement: "composer-above", order: 0, profiles: ["desktop", "compact"], Component: bind(WorkspaceFollower) });
    context.registerRegion({ id: "workspace.title-actions", placement: "title-bar", order: 10, profiles: ["desktop"], Component: bind(WorkspaceTitleActions) });
    // The design's Editor button at the stage strip's right end.
    context.registerRegion({ id: "workspace.open-in", placement: "stage-bar", order: 10, profiles: ["desktop"], Component: bind(WorkspaceEditorButton) });
    // The branch in the thread header: a menu over the checkout, or a new thread's Branch section.
    context.registerRegion({ id: "workspace.branch", placement: "thread-branch", order: 10, profiles: ["desktop"], Component: bind(ThreadBranch) });
    // A new thread's branch as a pill under its heading, beside project and machine; a sheet on touch.
    context.registerRegion({ id: "workspace.draft-branch", placement: "draft-actions", order: 10, profiles: ["desktop"], Component: bind(createDraftBranchPill(false)) });
    context.registerRegion({ id: "workspace.draft-branch-sheet", placement: "draft-actions", order: 10, profiles: ["compact"], Component: bind(createDraftBranchPill(true)) });
    // Offered while another thread's turn runs in the draft's folder; the phone gets it too.
    context.registerRegion({ id: "workspace.worktree-suggestion", placement: "draft-actions", order: 11, profiles: ["desktop", "compact"], Component: bind(WorktreeSuggestionPill) });
    const documents = documentStates(store);
    context.registerDocumentSource({
      profiles: ["desktop", "compact"],
      id: "workspace.documents",
      // The stage names the project its tabs belong to; a caller that does not means the followed one.
      loadFile: (relPath, from) => host.readFile(relPath, from?.workspace ?? store.workspace()),
      loadDiff: (relPath, options, from) => host.getFileDiff(relPath, options, from?.workspace ?? store.workspace()),
      openInEditor: (relPath) => void store.openInEditor(relPath),
      getState: documents,
      subscribe: store.subscribe,
      listFiles: async () => {
        const files: string[] = [];
        const state = store.getSnapshot();
        const walk = (nodes: readonly FileNode[]) => {
          for (const node of nodes) {
            if (node.kind === "file") files.push(node.path);
            if (node.children) walk(node.children);
          }
        };
        if (state.fileTree.length > 0) {
          walk(state.fileTree);
        } else {
          try {
            const tree = await host.getFileTree(undefined, store.workspace());
            if (tree) walk(tree);
          } catch {
            // ignore
          }
        }
        for (const file of state.changes.files) {
          if (!files.includes(file.path)) files.push(file.path);
        }
        return files;
      },
    });
    context.events.on("user-message", (event) => store.turnStarted(event.sessionId));
    context.events.on("agent-status", (event) => { if (!event.running) store.turnSettled(event.sessionId); });
    context.events.on("tool-end", (event) => store.toolFinished(event.tool));
    // Transcript checkpoint cards and their historical review belong to the
    // workspace contribution. Removing Workspace Kit therefore removes both
    // the card and its diff surface without App knowing their implementation.
    registerCheckpoints(context, store);
    void store.loadTurnStats();
    const storageCall = <K extends keyof WorktreeStorageHostCommands>(command: K, input: WorktreeStorageHostCommands[K]["input"]) =>
      context.host.invoke(command, input) as Promise<WorktreeStorageHostCommands[K]["output"]>;
    context.registerSettingsPage({
      id: "workspace.storage",
      label: "Storage",
      description: "Worktrees Tau made for threads, what they take on disk and the rules that remove them. A rule never removes uncommitted work, unpushed commits or ignored files but node_modules, and every branch stays.",
      group: "projects",
      Icon: HardDrive,
      order: 50,
      keywords: ["worktrees", "cleanup", "disk space", "delete worktree"],
      rows: STORAGE_SETTINGS_ROWS,
      profiles: ["desktop", "web"],
      Component: createStoragePage({
        report: () => storageCall("storage-report", undefined),
        setPolicy: (patch) => storageCall("cleanup-policy", patch),
        cleanUp: (paths) => storageCall("cleanup-run", { paths }),
        remove: (path, confirm) => storageCall("storage-remove", { path, confirm }),
        onChanged: (listener) => context.host.onEvent(STORAGE_CHANGED_EVENT, listener),
      }),
    });
    context.registerSettingsPage({
      id: "workspace.source-control",
      label: "Source control",
      description: "Where new threads run and what they start from: worktrees, branches, submodules, and the folder new projects start in.",
      group: "projects",
      Icon: GitBranch,
      order: 35,
      scope: "both",
      keywords: ["git", "worktree", "submodules", "pull", "fast-forward", "default branch", "clone", "base folder", "origin"],
      rows: SOURCE_CONTROL_SETTINGS_ROWS,
      profiles: ["desktop", "web"],
      Component: SourceControlPage,
    });
    // Clones run on the host; their toasts follow its pushes, also for one started before a reload.
    context.host.onEvent(CLONE_PROGRESS_EVENT, (payload) => store.clones.receive(payload));
    host.listClones().then((clones) => { if (Array.isArray(clones)) for (const clone of clones) store.clones.receive(clone); }, () => undefined);
    const autoPull = () => void store.autoPullDefaultBranch();
    const autoPullTimer = window.setInterval(autoPull, AUTO_PULL_INTERVAL_MS);
    window.addEventListener("focus", autoPull);
    // `tau app <path>`: a request pushed now, or one that waited for this window.
    const openRequests = new OpenRequests();
    context.host.onEvent(OPEN_REQUEST_EVENT, (payload) => openRequests.receive(payload));
    // Only a client that follows requests takes the waiting one, and only once it knows one waits.
    let took = false;
    const takeWaiting = () => {
      if (took) return;
      took = true;
      context.host.invoke(OPEN_REQUEST_WAITING_COMMAND)
        .then((waiting) => (waiting === true ? context.host.invoke(TAKE_OPEN_REQUEST_COMMAND) : null))
        .then((request) => openRequests.receive(request), () => undefined);
    };
    context.registerRegion({
      id: "workspace.open-requests",
      placement: "composer-above",
      order: 1,
      profiles: ["desktop", "web"],
      Component: function OpenRequestFollower({ actions }) {
        useEffect(() => openRequests.bind(actions), [actions]);
        useEffect(takeWaiting, []);
        return null;
      },
    });
    // A new thread's worktree is created while its first prompt waits (ADR 0017).
    context.registerPromptHook({
      id: "workspace.new-thread-worktree",
      beforeNewThread: (event) => store.prepareThreadWorktree(event),
    });
    context.registerOptions([
      { id: START_FROM_ORIGIN_OPTION, kind: "toggle", label: "New worktrees start from origin", defaultValue: true },
      {
        id: NEW_THREAD_WORKSPACE_KEY,
        kind: "select",
        label: "New threads run in",
        values: [{ value: "current", label: "Current checkout" }, { value: "worktree", label: "A new worktree" }],
        defaultValue: "current",
      },
      ...RAIL_ORDER_OPTIONS,
      { id: "show-settled", kind: "toggle", label: "Show settled shelf", defaultValue: true },
      { id: "compact-rows", kind: "toggle", label: "Compact rows in the thread rail", defaultValue: false },
      { id: "sources", kind: "chips", label: "Add-project sources", values: ["local folder", "git clone"] },
    ]);
    context.registerCommand({ id: "workspace.files", label: "Open file index", group: "Project", access: "read", run: (app) => app.openPanel(WORKSPACE_FILES_PANEL) });
    context.registerCommand({ id: "workspace.changes", label: "Inspect Git changes", group: "Project", access: "read", run: (app) => app.openPanel(WORKSPACE_CHANGES_PANEL) });
    context.registerCommand({ id: "workspace.open-project", label: "Open project…", group: "Project", access: "write", run: async (app) => {
      try {
        const picked = await host.pickFolder();
        if (picked) await app.openWorkspace(picked.workspaceId);
      } catch (error) {
        app.notify(errorMessage(error));
      }
    } });
    context.registerCommand({
      id: "workspace.add-project",
      label: "Add project…",
      group: "Project",
      access: "write",
      submenu: addProjectMenu({ listDirectories: (path) => host.listDirectories(path), pickFolder: () => host.pickFolder(), baseDirectory: () => store.projectBaseDirectory() }),
      run: (app) => app.openCommandPalette({ menu: "workspace.add-project" }),
    });
    context.registerCommand({ id: "workspace.switch-project", label: "Switch project…", group: "Project", access: "write", run: () => requestProjectSwitcher() });
    context.registerCommand({
      id: "workspace.project-settings",
      label: "Project settings…",
      group: "Project",
      access: "write",
      run: (app) => {
        const active = app.activeThread();
        const cwd = active?.cwd ?? store.getSnapshot().cwd;
        if (!cwd) { app.notify("Open a project first."); return; }
        store.openProjectSettings({ projectPath: cwd, projectName: cwd.split("/").pop() ?? cwd, ...(active?.workspaceId ? { workspaceId: active.workspaceId } : {}) });
      },
    });
    context.registerCommand({
      id: "workspace.open-in-editor",
      label: "Open in external editor",
      group: "Project",
      access: "write",
      // The thread's menu keeps it in reach while the stage, whose strip has the button, is hidden.
      surfaces: ["thread-title"],
      run: async (app) => {
        const activeEditor = store.activeEditor();
        if (activeEditor) app.notify(`Opening in ${activeEditor.name}…`);
        await store.openInEditor();
      },
    });
    context.registerCommand({
      id: "workspace.open-terminal",
      label: "Open in external terminal",
      group: "Project",
      access: "write",
      run: async (app) => {
        const activeTerminal = store.activeTerminal();
        if (activeTerminal) app.notify(`Opening in ${activeTerminal.name}…`);
        await store.openTerminal();
      },
    });
    context.registerCommand({ id: "workspace.settle", label: "Settle thread", group: "Thread", access: "write", run: (app) => app.settleActiveThread() });
    // The branch is the kit's fact; the title menu only lends the slot.
    context.registerCommand({ id: "workspace.copy-branch", label: "Copy branch", group: "Thread", surfaces: ["thread-title"], access: "read", run: async (app) => {
      const branch = store.getSnapshot().workspace?.branch;
      if (!branch) { app.notify("Branch is unavailable."); return; }
      try { await app.copyText(branch); app.notify("Branch copied."); } catch (error) { app.notify(errorMessage(error)); }
    } });
    // Composer chords: each opens the composer control that carries its id.
    for (const [id, label, keys] of [["composer.workspace", "Choose where the thread runs", "mod+shift+x"], ["composer.branch", "Choose the branch", "mod+shift+g"]] as const) {
      context.registerCommand({ id, label, group: "Composer", access: "write", run: (app) => {
        const control = document.querySelector<HTMLElement>(`[data-composer-shortcut~="${id}"]`);
        if (control) control.click();
        else app.notify("The composer shows no such control here.");
      } });
      context.registerKeybinding({ keys, commandId: id, when: "!terminalFocus" });
    }
    context.registerKeybinding({ keys: "mod+alt+p", commandId: "workspace.open-project" });
    context.registerKeybinding({ keys: "mod+o", commandId: "workspace.open-in-editor" });
    context.registerKeybinding({ keys: "mod+alt+j", commandId: "workspace.open-terminal" });
    context.registerKeybinding({ keys: "mod+shift+s", commandId: "workspace.settle" });
    context.registerToolRenderer(
      "workspace.read-renderer",
      (tool) => tool.name === "read" || tool.name === "grep" || tool.name === "find" || tool.name === "ls",
      (tool) => ({
        glyph: "→",
        title: tool.name,
        tone: "read",
        detail: String(tool.args.path ?? tool.args.pattern ?? tool.args.query ?? "workspace"),
        ...(tool.name === "read" && typeof tool.args.path === "string" ? { file: tool.args.path } : {}),
      }),
      { profiles: ["desktop", "web", "compact"] },
    );
    context.registerToolRenderer(
      "workspace.write-renderer",
      (tool) => tool.name === "edit" || tool.name === "write",
      (tool) => ({
        glyph: "±",
        title: tool.name,
        tone: "write",
        detail: String(tool.args.path ?? "file mutation"),
        ...(typeof tool.args.path === "string" ? { file: tool.args.path } : {}),
      }),
      { profiles: ["desktop", "web", "compact"] },
    );

    let lastAppActions: import("tau").WorkbenchActions | undefined;
    const openPromptInEditor = async (app?: import("tau").WorkbenchActions) => {
      const actions = app ?? lastAppActions;
      if (!actions) return;
      lastAppActions = actions;
      const draft = actions.composerDraft();
      try {
        const result = (await context.host.invoke("edit-prompt-external", {
          text: draft,
          editorId: store.activeEditor()?.id,
        })) as { path?: string; editor?: string };
        if (!result?.path) return;
        actions.notify(`Opened draft in ${result.editor ?? "editor"}. Updating on save…`);
        let lastText = draft;
        let checks = 0;
        const interval = setInterval(async () => {
          checks++;
          if (checks > 180) { clearInterval(interval); return; }
          try {
            const read = (await context.host.invoke("read-prompt-external", { path: result.path })) as { text?: string };
            if (read?.text !== undefined && read.text !== lastText) {
              lastText = read.text;
              actions.focusComposer(read.text);
            }
          } catch {
            clearInterval(interval);
          }
        }, 1000);
      } catch (error) {
        actions.notify(errorMessage(error));
      }
    };

    context.registerCommand({
      id: "workspace.open-prompt-editor",
      label: "Edit prompt in external editor",
      group: "Thread",
      access: "write",
      run: (app) => { lastAppActions = app; void openPromptInEditor(app); },
    });
    context.registerSlashCommand({
      name: "editor",
      description: "Open the current prompt draft in your external editor",
      run: (_args, app) => { lastAppActions = app; void openPromptInEditor(app); return undefined; },
    });
    context.registerSlashCommand({
      name: "diff",
      description: "Inspect Git changes in stage",
      run: (_args, app) => { app.openPanel(WORKSPACE_CHANGES_PANEL); return undefined; },
    });
    context.registerSlashCommand({
      name: "files",
      description: "Open file index in stage",
      run: (_args, app) => { app.openPanel(WORKSPACE_FILES_PANEL); return undefined; },
    });
    context.registerSlashCommand({
      name: "code",
      description: "Open current project in external editor (VS Code, Cursor, Zed)",
      run: (_args, app) => {
        const activeEditor = store.activeEditor();
        if (!activeEditor) return "No supported editor found on PATH.";
        app.notify(`Opening in ${activeEditor.name}…`);
        void store.openInEditor();
        return undefined;
      },
    });
    context.registerKeybinding({ keys: "mod+e", commandId: "workspace.open-prompt-editor" });
    return () => {
      unpublishIcons();
      window.clearInterval(autoPullTimer);
      window.removeEventListener("focus", autoPull);
    };
  },
};

export default workspaceExtension;
