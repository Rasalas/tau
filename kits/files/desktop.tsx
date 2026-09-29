import { FilePen } from "lucide-react";
import { errorMessage, type DesktopExtension, type StageTabHandle, type WorkbenchActions } from "tau";
import type { FileDocument } from "./document.js";
import { DocumentRegistry } from "./documents.js";
import { fileEditorParams, fileName, FileEditorTab, MediaTab, saveDocument, UnknownProjectTab } from "./editor-tab.js";
import { fileViewKind } from "./file-kind.js";
import { AUTOSAVE_OPTION, autosaveDelay, kit, WRAP_OPTION, workspaceRelative, type WorkspaceStoreLike } from "./kit.js";
import { createFilesHost, FILE_EDITOR_TAB, FILES_KIT_ID, UNKNOWN_PROJECT, WORKSPACE_STORE_SERVICE, type FileEditorParams } from "./protocol.js";

/** Which document each tab's dot follows; a handle lives as long as its tab. */
const bindings = new WeakMap<StageTabHandle, { document: FileDocument; stop(): void }>();

/**
 * The dot on the tab follows the document even while the tab is in the
 * background. The document can be a new one — another project's stage has a
 * tab of the same path, or this kit reloaded — so the binding moves with it.
 */
function bindTab(handle: StageTabHandle, params: FileEditorParams, workspace: string): FileDocument | undefined {
  const current = kit.current;
  if (!current) return undefined;
  const document = current.documents.open(workspace, params.path);
  const bound = bindings.get(handle);
  if (bound?.document === document) return document;
  if (bound) bound.stop();
  else handle.onClose(() => {
    const closing = bindings.get(handle);
    closing?.stop();
    bindings.delete(handle);
    if (closing) kit.current?.documents.close(closing.document);
  });
  bindings.set(handle, { document, stop: document.subscribe(() => handle.setDirty(document.getState().dirty)) });
  handle.setDirty(document.getState().dirty);
  return document;
}

export function openFileEditor(actions: WorkbenchActions, relPath: string, line?: number): void {
  actions.openStageTab(FILE_EDITOR_TAB, line ? { path: relPath, line } : { path: relPath }, { key: relPath });
}

/** The project on screen, whose stage the commands act on; undefined when the window knows none. */
function shownProject(actions: WorkbenchActions): string | undefined {
  const thread = actions.activeThread();
  return thread?.workspaceId ?? thread?.cwd;
}

/**
 * Files Kit: a workspace file as a stage tab of its own, editable and saved
 * through Workspace Kit's host, with Markdown, HTML and tables rendered beside
 * their source and PDFs, images, audio and video in the browser's viewers.
 */
export const filesExtension: DesktopExtension = {
  id: FILES_KIT_ID,
  name: "Files",
  activate(context) {
    const host = createFilesHost((command, input) => context.host.invoke(command, input));
    const documents = new DocumentRegistry(host, () => autosaveDelay(context.preferences));
    const listeners = new Set<() => void>();
    kit.current = { documents, preferences: context.preferences, listeners };
    const announce = () => { for (const listener of [...listeners]) listener(); };

    context.registerOptions([
      { id: AUTOSAVE_OPTION, kind: "toggle", label: "Save edited files automatically after a second", defaultValue: false },
      { id: WRAP_OPTION, kind: "toggle", label: "Wrap long lines in the editor", defaultValue: false },
    ]);

    context.registerStageTab<FileEditorParams>({
      kind: FILE_EDITOR_TAB,
      // A tablet edits beside the chat as the desktop does; a phone draws no stage and reads in the Files sheet.
      profiles: ["desktop", "compact"],
      title: (params) => fileName(fileEditorParams(params).path),
      Icon: FilePen,
      restore: (params) => Boolean(fileEditorParams(params).path),
      // The tab reads and saves in the project whose stage it is on, never in the one the host has open.
      render: (raw, handle, actions, from) => {
        const params = fileEditorParams(raw);
        const workspace = from?.workspace;
        if (!workspace) return <UnknownProjectTab path={params.path} />;
        const key = `${workspace}\u0000${params.path}`;
        if (fileViewKind(params.path) !== "text") return <MediaTab key={key} params={params} handle={handle} actions={actions} />;
        const document = bindTab(handle, params, workspace);
        return document ? <FileEditorTab key={key} params={params} handle={handle} actions={actions} document={document} /> : null;
      },
    });

    context.useService<WorkspaceStoreLike>(WORKSPACE_STORE_SERVICE, (store) => {
      if (kit.current) kit.current.workspace = store;
      announce();
      const offer = store.registerFileEditor?.((relPath, actions) => openFileEditor(actions, relPath));
      return () => {
        offer?.();
        if (kit.current?.workspace === store) kit.current.workspace = undefined;
        announce();
      };
    });

    context.registerCommand({
      id: "files.edit",
      label: "Edit file",
      group: "Project",
      access: "write",
      surfaces: ["file-tab"],
      run: (actions) => {
        const shown = actions.activeStageTab?.();
        if (shown?.kind !== "file") { actions.notify("Open a file on the stage first."); return; }
        const relPath = workspaceRelative(shown.path, kit.current?.workspace?.getSnapshot().cwd ?? actions.activeThread()?.cwd);
        if (!relPath) { actions.notify("Only a file of this project can be edited here."); return; }
        openFileEditor(actions, relPath, shown.line);
      },
    });

    context.registerCommand({
      id: "files.save",
      label: "Save file",
      group: "Project",
      access: "write",
      run: async (actions) => {
        const shown = actions.activeStageTab?.();
        const path = shown?.kind === "extension" && shown.tabKind === FILE_EDITOR_TAB ? fileEditorParams(shown.params).path : undefined;
        if (!path) { actions.notify("Open a file in the editor first."); return; }
        const workspace = shownProject(actions);
        if (!workspace) { actions.notify(`Not saved: ${UNKNOWN_PROJECT}`); return; }
        const document = documents.get(workspace, path);
        if (!document) { actions.notify("Open a file in the editor first."); return; }
        await saveDocument(document, fileName(path), actions);
      },
    });
    // In the editor only: everywhere else `mod+s` stashes the draft.
    context.registerKeybinding({ keys: "mod+s", commandId: "files.save", when: "editorFocus" });

    context.registerCommand({
      id: "files.save-all",
      label: "Save all edited files",
      group: "Project",
      access: "write",
      run: async (actions) => {
        const open = actions.stageTabs().filter((tab) => tab.kind === "extension" && tab.tabKind === FILE_EDITOR_TAB && tab.dirty);
        if (open.length === 0) return;
        const workspace = shownProject(actions);
        if (!workspace) { actions.notify(`Not saved: ${UNKNOWN_PROJECT}`); return; }
        for (const tab of open) {
          if (tab.kind !== "extension") continue;
          const document = documents.get(workspace, fileEditorParams(tab.params).path);
          if (!document) continue;
          try {
            if (!await document.save()) actions.notify(`${tab.title} was not saved.`);
          } catch (error) {
            actions.notify(errorMessage(error));
          }
        }
        void kit.current?.workspace?.refresh();
      },
    });

    // The agent writes files too: every open buffer asks the disk once its tool is done.
    context.events.on("tool-end", (event) => {
      if (event.tool.name === "edit" || event.tool.name === "write" || event.tool.name === "bash") void documents.checkAll();
    });
    // Tools of a thread this client does not show never reach it; the end of that thread's turn does.
    context.events.on("agent-status", (event) => { if (!event.running) void documents.checkAll(); });

    return () => {
      documents.clear();
      listeners.clear();
      if (kit.current?.documents === documents) kit.current = undefined;
    };
  },
};

export default filesExtension;
