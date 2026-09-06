import { lazy } from "react";
import { type DesktopExtension } from "../extension-system";
import { getHostClient } from "../host-client-context";

// Keep optional extension UI out of the workbench's first renderer chunk. The
// registry still owns activation; React loads a contribution when its slot is
// actually rendered.
const LazyFilesPanel = lazy(() => import("./workspace-panels").then(({ FilesPanel }) => ({ default: FilesPanel })));
const LazyCloneProjectSource = lazy(() => import("./project-navigation").then(({ CloneProjectSource }) => ({ default: CloneProjectSource })));
const LazyLocalFolderSource = lazy(() => import("./project-navigation").then(({ LocalFolderSource }) => ({ default: LocalFolderSource })));
const LazyWorkspaceSidebar = lazy(() => import("./project-navigation").then(({ WorkspaceSidebar }) => ({ default: WorkspaceSidebar })));
import { claudeCodeExtension } from "./claude-code-kit";
import { workspaceKit } from "./workspace-kit-client";
import { registerCheckpoints } from "./workspace-checkpoints";
import { TurnChangesDock, WorkspaceBarControl, WorkspaceFollower } from "./workspace-dock";
import { WorkspaceTitleActions } from "./workspace-title";
import type { WorkspaceStore } from "./workspace-store";
import { piUiExtension } from "./pi-ui";

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

export const bundledExtensions = [
  workspaceExtension,
  piUiExtension,
  claudeCodeExtension,
];
