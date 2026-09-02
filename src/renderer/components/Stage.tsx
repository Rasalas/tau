import { useMemo, type KeyboardEvent } from "react";
import type { DiffLoadOptions, UiEditor, UiFileContent, UiFileDiff, UiWorkspaceChanges } from "../../shared/workspace-kit-types";
import { activeTab, type StageState, type StageView } from "../stage";
import { FileViewer } from "./FileViewer";
import { StageTabs, type ChatTab } from "./StageTabs";

function relativeTo(cwd: string | undefined, path: string): string {
  return cwd && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path;
}

function isEditable(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.isContentEditable);
}

export function Stage({
  stage, cwd, changes, editor, chatTab,
  loadFile, loadDiff,
  onActivate, onClose, onPin, onChangeView, onOpenInEditor,
}: {
  stage: StageState;
  cwd?: string;
  changes: UiWorkspaceChanges;
  editor?: UiEditor;
  /** Present while the chat shares the tab strip because the centre is too narrow for both. */
  chatTab?: ChatTab;
  loadFile(path: string): Promise<UiFileContent>;
  loadDiff(path: string, options?: DiffLoadOptions): Promise<UiFileDiff>;
  onActivate(id: string): void;
  onClose(id: string): void;
  onPin(id: string): void;
  onChangeView(id: string, view: StageView): void;
  onOpenInEditor(path: string): void;
}) {
  const current = activeTab(stage);
  const changedRelative = useMemo(() => new Set(changes.files.map((file) => file.path)), [changes.files]);
  const changedAbsolute = useMemo(
    () => new Set(cwd ? changes.files.map((file) => `${cwd}/${file.path}`) : []),
    [changes.files, cwd],
  );

  // Escape closes the tab under focus; it must not bubble to the window
  // listener that aborts a streaming run.
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || !current || chatTab?.active || isEditable(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    onClose(current.id);
  };

  return <section className="stage" aria-label="Stage" onKeyDown={onKeyDown}>
    <StageTabs
      tabs={stage.tabs}
      activeId={stage.activeId}
      changedPaths={changedAbsolute}
      chatTab={chatTab}
      onActivate={onActivate}
      onClose={onClose}
      onPin={onPin}
    />
    {current && !chatTab?.active ? (
      <FileViewer
        key={current.id}
        tab={current}
        relativePath={relativeTo(cwd, current.path)}
        changed={changedRelative.has(relativeTo(cwd, current.path))}
        editor={editor}
        loadFile={loadFile}
        loadDiff={loadDiff}
        onChangeView={(view) => onChangeView(current.id, view)}
        onOpenInEditor={onOpenInEditor}
      />
    ) : null}
  </section>;
}
