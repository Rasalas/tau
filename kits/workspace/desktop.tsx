import { Files, GitCompare } from "lucide-react";
import {
  errorMessage,
  type DesktopExtension,
  type FileNode,
  type UiEditor,
  type UiWorkspaceChanges,
} from "tau";
import {
  createWorkspaceHostClient,
  WORKSPACE_CHANGES_PANEL,
  WORKSPACE_FILES_PANEL,
  WORKSPACE_HOST_EXTENSION_ID,
  WORKSPACE_STORE_SERVICE,
} from "./protocol.js";
import { registerCheckpoints } from "./checkpoints.js";
import { TurnChangesDock, WorkspaceBarControl, WorkspaceFollower } from "./dock.js";
import { CloneProjectSource, LocalFolderSource, WorkspaceSidebar } from "./navigation.js";
import { ChangesPanel, FilesPanel } from "./panels.js";
import { NEW_THREAD_WORKSPACE_KEY, START_FROM_ORIGIN_OPTION, WorkspaceStore } from "./store.js";
import { withWorkspaceStore } from "./store-context.js";
import { WorkspaceTitleActions } from "./title.js";

/** Stable object per (changes, editors, editor preference) so the stage's store snapshot does not churn. */
function documentStates(store: WorkspaceStore): () => { changes: UiWorkspaceChanges; editor?: UiEditor } {
  let last: { changes: UiWorkspaceChanges; editor?: UiEditor } | undefined;
  let inputs: [unknown, unknown, string | undefined] | undefined;
  return () => {
    const state = store.getSnapshot();
    const editor = store.activeEditor();
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
    context.registerPanel({ id: WORKSPACE_FILES_PANEL, label: "Files", Icon: Files, order: 10, profiles: ["desktop"], Component: bind(FilesPanel) });
    // The Changes panel reads the same Git state as the rest of the kit, so it
    // travels with it; Review Kit still opens it by id from its own command.
    context.registerPanel({ id: WORKSPACE_CHANGES_PANEL, label: "Changes", Icon: GitCompare, order: 20, profiles: ["desktop"], Component: bind(ChangesPanel) });
    // The kit owns its workspace state; these keep it following the workbench
    // and place its controls where core lends room.
    context.registerRegion({ id: "workspace.follower", placement: "composer-above", order: 0, profiles: ["desktop"], Component: bind(WorkspaceFollower) });
    context.registerRegion({ id: "workspace.title-actions", placement: "title-bar", order: 10, profiles: ["desktop"], Component: bind(WorkspaceTitleActions) });
    context.registerRegion({ id: "workspace.turn-changes", placement: "transcript-footer", order: 10, profiles: ["desktop"], Component: bind(TurnChangesDock) });
    context.registerComposerControl({ id: "workspace.bar", placement: "footer", order: 10, profiles: ["desktop"], Component: bind(WorkspaceBarControl) });
    const documents = documentStates(store);
    context.registerDocumentSource({
      profiles: ["desktop"],
      id: "workspace.documents",
      loadFile: (relPath) => host.readFile(relPath),
      loadDiff: (relPath, options) => host.getFileDiff(relPath, options),
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
            const tree = await host.getFileTree();
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
      { id: "group-by-project", kind: "toggle", label: "Group threads by project instead of recency", defaultValue: false },
      { id: "show-settled", kind: "toggle", label: "Show settled shelf", defaultValue: true },
      { id: "compact-rows", kind: "toggle", label: "Compact rows in the thread rail", defaultValue: false },
      { id: "sources", kind: "chips", label: "Add-project sources", values: ["local folder", "git clone"] },
    ]);
    context.registerCommand({ id: "workspace.files", label: "Open file index", group: "Project", run: (app) => app.openPanel(WORKSPACE_FILES_PANEL) });
    context.registerCommand({ id: "workspace.changes", label: "Inspect Git changes", group: "Project", run: (app) => app.openPanel(WORKSPACE_CHANGES_PANEL) });
    context.registerCommand({ id: "workspace.open-project", label: "Open project…", group: "Project", run: async (app) => {
      try {
        const picked = await host.pickFolder();
        if (picked) await app.openWorkspace(picked.workspaceId);
      } catch (error) {
        app.notify(errorMessage(error));
      }
    } });
    context.registerCommand({
      id: "workspace.open-in-editor",
      label: "Open in external editor",
      group: "Project",
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
      run: async (app) => {
        const activeTerminal = store.activeTerminal();
        if (activeTerminal) app.notify(`Opening in ${activeTerminal.name}…`);
        await store.openTerminal();
      },
    });
    context.registerCommand({ id: "workspace.settle", label: "Settle thread", group: "Thread", run: (app) => app.settleActiveThread() });
    // The branch is the kit's fact; the title menu only lends the slot.
    context.registerCommand({ id: "workspace.copy-branch", label: "Copy branch", group: "Thread", surfaces: ["thread-title"], run: async (app) => {
      const branch = store.getSnapshot().workspace?.branch;
      if (!branch) { app.notify("Branch is unavailable."); return; }
      try { await app.copyText(branch); app.notify("Branch copied."); } catch (error) { app.notify(errorMessage(error)); }
    } });
    context.registerKeybinding({ keys: "mod+p", commandId: "workspace.open-project" });
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
    context.registerSlashCommand({
      name: "terminal",
      description: "Open current project in external terminal (Ghostty, iTerm, Warp, Terminal)",
      run: (_args, app) => {
        const activeTerminal = store.activeTerminal();
        if (!activeTerminal) return "No supported terminal found.";
        app.notify(`Opening in ${activeTerminal.name}…`);
        void store.openTerminal();
        return undefined;
      },
    });
    context.registerSlashCommand({
      name: "term",
      description: "Open current project in external terminal (Ghostty, iTerm, Warp, Terminal)",
      run: (_args, app) => {
        const activeTerminal = store.activeTerminal();
        if (!activeTerminal) return "No supported terminal found.";
        app.notify(`Opening in ${activeTerminal.name}…`);
        void store.openTerminal();
        return undefined;
      },
    });
    context.registerKeybinding({ keys: "mod+e", commandId: "workspace.open-prompt-editor" });
  },
};

export default workspaceExtension;
