import { useMemo, type KeyboardEvent, type RefObject } from "react";
import type { UiMessage } from "../../shared/contracts";
import type { DiffLoadOptions, UiEditor, UiFileContent, UiFileDiff, UiWorkspaceChanges } from "../../shared/workspace-kit-types";
import { activeTab, type StageExtensionTab, type StageState, type StageView } from "../../workbench/stage";
import type { ExtensionRegistry, WorkbenchActions } from "../extension-system";
import type { StageTabController } from "../stage-tab-controller";
import { FileViewer } from "./FileViewer";
import { StageTabs, type ChatTab } from "./StageTabs";
import { ThreadDocument } from "./ThreadDocument";

function relativeTo(cwd: string | undefined, path: string): string {
  return cwd && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path;
}

function isEditable(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.isContentEditable);
}

/**
 * A tab a desktop extension drew. Core frames it and hands the kind the tab's
 * params and its handle; a kind that went away leaves the frame with a note,
 * because the tab itself is closed by the controller, not by this render.
 */
function ExtensionPane({ tab, registry, stageTabs, actions }: {
  tab: StageExtensionTab;
  registry?: ExtensionRegistry;
  stageTabs?: StageTabController;
  actions: WorkbenchActions;
}) {
  const contribution = registry?.getStageTabKind(tab.tabKind);
  if (!contribution || !stageTabs) {
    return <section className="stage-pane" aria-label={tab.title}>
      <div className="stage-empty" role="status">The extension that draws this tab is not active.</div>
    </section>;
  }
  return <section className="stage-pane" aria-label={tab.title}>
    {contribution.render(tab.params, stageTabs.handle(tab.id), actions)}
  </section>;
}

export function Stage({
  stage, cwd, changes, editor, chatTab, focusRef, registry, stageTabs, actions,
  loadFile, loadDiff, loadThread,
  onActivate, onClose, onPin, onUnpin, onCloseOthers, onCloseToRight, onChangeView, onOpenInEditor, onTakeOverThread,
}: {
  stage: StageState;
  focusRef?: RefObject<HTMLElement | null>;
  cwd?: string;
  changes: UiWorkspaceChanges;
  editor?: UiEditor;
  /** Present while the chat shares the tab strip because the centre is too narrow for both. */
  chatTab?: ChatTab;
  /** Who offers the stage tab kinds, and who holds their handles. */
  registry?: ExtensionRegistry;
  stageTabs?: StageTabController;
  /** Handed to an extension tab's content, as a panel gets them. */
  actions: WorkbenchActions;
  loadFile(path: string): Promise<UiFileContent>;
  loadDiff(path: string, options?: DiffLoadOptions): Promise<UiFileDiff>;
  /** The transcript of a thread the composer is not addressing. */
  loadThread(sessionId: string): Promise<UiMessage[]>;
  onActivate(id: string): void;
  onClose(id: string): void;
  onPin(id: string): void;
  onUnpin(id: string): void;
  onCloseOthers(id: string): void;
  onCloseToRight(id: string): void;
  onChangeView(id: string, view: StageView): void;
  onOpenInEditor(path: string): void;
  /** Makes a thread tab the thread the composer talks to. */
  onTakeOverThread(sessionId: string): void;
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

  return <section ref={focusRef} tabIndex={-1} className="stage" aria-label="Stage" onKeyDown={onKeyDown}>
    <StageTabs
      tabs={stage.tabs}
      activeId={stage.activeId}
      changedPaths={changedAbsolute}
      chatTab={chatTab}
      {...(registry ? { registry } : {})}
      onActivate={onActivate}
      onClose={onClose}
      onPin={onPin}
      onUnpin={onUnpin}
      onCloseOthers={onCloseOthers}
      onCloseToRight={onCloseToRight}
    />
    {!current || chatTab?.active ? null : current.kind === "extension" ? (
      <ExtensionPane
        key={current.id}
        tab={current}
        {...(registry ? { registry } : {})}
        {...(stageTabs ? { stageTabs } : {})}
        actions={actions}
      />
    ) : current.kind === "thread" ? (
      <ThreadDocument
        key={current.id}
        sessionId={current.sessionId}
        loadThread={loadThread}
        onTakeOver={onTakeOverThread}
      />
    ) : (
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
    )}
  </section>;
}
