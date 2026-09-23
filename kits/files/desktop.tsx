import { FilePen } from "lucide-react";
import { errorMessage, type DesktopExtension, type StageTabHandle, type WorkbenchActions } from "tau";
import type { FileDocument } from "./document.js";
import { DocumentRegistry } from "./documents.js";
import { fileEditorParams, fileName, FileEditorTab, MediaTab, saveDocument } from "./editor-tab.js";
import { fileViewKind } from "./file-kind.js";
import { AUTOSAVE_OPTION, autosaveDelay, kit, workspaceRelative, type WorkspaceStoreLike } from "./kit.js";
import { createFilesHost, FILE_EDITOR_TAB, FILES_KIT_ID, WORKSPACE_STORE_SERVICE, type FileEditorParams } from "./protocol.js";

/** Which document each tab's dot follows; a handle lives as long as its tab. */
const bindings = new WeakMap<StageTabHandle, { document: FileDocument; stop(): void }>();

/**
 * The dot on the tab follows the document even while the tab is in the
 * background. The document can be a new one — after a project switch or a
 * reload of this kit — so the binding moves with it.
 */
function bindTab(handle: StageTabHandle, params: FileEditorParams): FileDocument | undefined {
  const current = kit.current;
  if (!current) return undefined;
  const document = current.documents.open(params.path);
  const bound = bindings.get(handle);
  if (bound?.document === document) return document;
  if (bound) bound.stop();
  else handle.onClose(() => {
    bindings.get(handle)?.stop();
    bindings.delete(handle);
    kit.current?.documents.close(params.path);
  });
  bindings.set(handle, { document, stop: document.subscribe(() => handle.setDirty(document.getState().dirty)) });
  handle.setDirty(document.getState().dirty);
  return document;
}

export function openFileEditor(actions: WorkbenchActions, relPath: string, line?: number): void {
  actions.openStageTab(FILE_EDITOR_TAB, line ? { path: relPath, line } : { path: relPath }, { key: relPath });
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
    ]);

    context.registerStageTab<FileEditorParams>({
      kind: FILE_EDITOR_TAB,
      profiles: ["desktop"],
      title: (params) => fileName(fileEditorParams(params).path),
      Icon: FilePen,
      restore: (params) => Boolean(fileEditorParams(params).path),
      render: (raw, handle, actions) => {
        const params = fileEditorParams(raw);
        if (fileViewKind(params.path) !== "text") return <MediaTab key={params.path} params={params} handle={handle} actions={actions} />;
        const document = bindTab(handle, params);
        return document ? <FileEditorTab key={params.path} params={params} handle={handle} actions={actions} document={document} /> : null;
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
      run: async (actions) => {
        const shown = actions.activeStageTab?.();
        const path = shown?.kind === "extension" && shown.tabKind === FILE_EDITOR_TAB ? fileEditorParams(shown.params).path : undefined;
        const document = path ? documents.get(path) : undefined;
        if (!path || !document) { actions.notify("Open a file in the editor first."); return; }
        await saveDocument(document, fileName(path), actions);
      },
    });
    // As in T3 Code, in the editor only: everywhere else `mod+s` stashes the draft.
    context.registerKeybinding({ keys: "mod+s", commandId: "files.save", when: "editorFocus" });

    context.registerCommand({
      id: "files.save-all",
      label: "Save all edited files",
      group: "Project",
      run: async (actions) => {
        const open = actions.stageTabs().filter((tab) => tab.kind === "extension" && tab.tabKind === FILE_EDITOR_TAB && tab.dirty);
        for (const tab of open) {
          if (tab.kind !== "extension") continue;
          const document = documents.get(fileEditorParams(tab.params).path);
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
    // Another project's paths name other files.
    context.events.on("workspace-changed", (event) => { if (event.from && event.from !== event.to) documents.clear(); });

    return () => {
      documents.clear();
      listeners.clear();
      if (kit.current?.documents === documents) kit.current = undefined;
    };
  },
};

export default filesExtension;
