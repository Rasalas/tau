import { useEffect, useMemo, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { Maximize2, Minimize2, PanelRight } from "lucide-react";
import type { UiMessage } from "../../shared/contracts";
import type { DiffLoadOptions, UiEditor, UiFileContent, UiFileDiff, UiWorkspaceChanges } from "../../shared/workspace-kit-types";
import { activeTab, splitTab, type StageExtensionTab, type StageState, type StageTab, type StageView } from "../../workbench/stage";
import type { DocumentOrigin, ExtensionRegistry, WorkbenchActions } from "../extension-system";
import type { StageTabController } from "../stage-tab-controller";
import { FileViewer } from "./FileViewer";
import { STAGE_TAB_DRAG, StageTabs } from "./StageTabs";
import { lookInMachine } from "../../workbench/look-in";
import { usePlatform } from "../platform-context";
import { RemoteThreadDocument } from "./RemoteThreadDocument";
import { ThreadDocument } from "./ThreadDocument";
import { tooltipProps } from "./ui/Tooltip";
import "./stage-panels.css";

export { StageTools } from "./StageSpine";

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
function ExtensionPane({ tab, registry, stageTabs, actions, from }: {
  tab: StageExtensionTab;
  registry?: ExtensionRegistry | undefined;
  stageTabs?: StageTabController | undefined;
  actions: WorkbenchActions;
  from: DocumentOrigin;
}) {
  const contribution = registry?.getStageTabKind(tab.tabKind);
  if (!contribution || !stageTabs) {
    return <section className="stage-pane" aria-label={tab.title}>
      <div className="stage-empty" role="status">The extension that draws this tab is not active.</div>
    </section>;
  }
  return <section className="stage-pane" aria-label={tab.title}>
    {contribution.render(tab.params, stageTabs.handle(tab.id), actions, from)}
  </section>;
}

export function Stage({
  stage, cwd, workspace, changes, editor, maximize, tools, focusRef, registry, stageTabs, actions,
  loadFile, loadDiff, loadThread,
  onActivate, onClose, onPin, onUnpin, onCloseOthers, onCloseToRight, onChangeView, onOpenInEditor, onTakeOverThread, renderPanel,
}: {
  stage: StageState;
  focusRef?: RefObject<HTMLElement | null>;
  cwd?: string;
  /** The project this stage is stored for: its workspace id, or its path where the host mints none. */
  workspace?: string;
  changes: UiWorkspaceChanges;
  editor?: UiEditor;
  /**
   * Present where chat and stage fit side by side: the stage can take the whole centre, the chat out of sight.
   * Where only one fits, the way back to the chat, named by `label`.
   */
  maximize?: { maximized: boolean; label?: string; onToggle(): void };
  /** The strip's own buttons before the maximize: the tools, and what kits place in `stage-bar`. */
  tools?: ReactNode;
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
  /** Where a maximized panel draws; the workbench keeps the panel itself. */
  renderPanel?(panelId: string): ReactNode;
}) {
  const current = activeTab(stage);
  const beside = splitTab(stage);
  const environments = usePlatform().environments;
  const from = useMemo<DocumentOrigin>(() => workspace ? { workspace } : {}, [workspace]);
  const changedRelative = useMemo(() => new Set(changes.files.map((file) => file.path)), [changes.files]);
  // A tab names its file relative to the project, or absolutely when a source did.
  const changedPaths = useMemo(
    () => new Set([...changedRelative, ...(cwd ? changes.files.map((file) => `${cwd}/${file.path}`) : [])]),
    [changedRelative, changes.files, cwd],
  );

  // Escape closes the tab under focus; it must not bubble to the window
  // listener that aborts a streaming run.
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || !current || isEditable(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    onClose(current.id);
  };

  // A tab dragged below the strip splits the stage when let go (design 2f). On the window:
  // a panel on the stage is drawn elsewhere in React's tree, so its events never reach this section's props.
  const [dropping, setDropping] = useState(false);
  const tabCount = stage.tabs.length;
  useEffect(() => {
    const on = (event: DragEvent) => {
      const target = event.target as Element;
      const inside = event.type !== "dragend" && tabCount > 1 && !!event.dataTransfer?.types.includes(STAGE_TAB_DRAG) && !!target.closest?.(".stage") && !target.closest(".stage-strip");
      if (inside) event.preventDefault();
      if (inside && event.type === "drop") stageTabs?.split(event.dataTransfer!.getData(STAGE_TAB_DRAG));
      setDropping(inside && event.type === "dragover");
    };
    const kinds = ["dragover", "drop", "dragend"] as const;
    for (const kind of kinds) addEventListener(kind, on);
    return () => { for (const kind of kinds) removeEventListener(kind, on); };
  }, [tabCount, stageTabs]);

  const pane = (tab: StageTab | undefined) => {
    const lookIn = tab?.kind === "thread" ? lookInMachine(tab.machine, environments) : undefined;
    return !tab ? (
      <div className="stage-empty" role="status">Nothing is open here.</div>
    ) : tab.kind === "panel" ? (
      <section key={tab.id} className="stage-pane panel-pane" aria-label={registry?.getPanels().find((panel) => panel.id === tab.panelId)?.label ?? tab.panelId}>
        {renderPanel?.(tab.panelId) ?? <div className="stage-empty" role="status">The extension that draws this panel is not active.</div>}
      </section>
    ) : tab.kind === "extension" ? (
      <ExtensionPane
        key={tab.id}
        tab={tab}
        registry={registry}
        stageTabs={stageTabs}
        actions={actions}
        from={from}
      />
    ) : tab.kind === "thread" && lookIn ? (
      <RemoteThreadDocument key={tab.id} machine={lookIn} sessionId={tab.sessionId} actions={actions} registry={registry} />
    ) : tab.kind === "thread" ? (
      <ThreadDocument
        key={tab.id}
        sessionId={tab.sessionId}
        loadThread={loadThread}
        onTakeOver={onTakeOverThread}
      />
    ) : (
      <FileViewer
        key={tab.id}
        tab={tab}
        relativePath={relativeTo(cwd, tab.path)}
        changed={changedRelative.has(relativeTo(cwd, tab.path))}
        stat={changes.files.find((file) => file.path === relativeTo(cwd, tab.path))}
        editor={editor}
        commands={registry?.getCommandsFor("file-tab") ?? []}
        actions={actions}
        loadFile={loadFile}
        loadDiff={loadDiff}
        onChangeView={(view) => onChangeView(tab.id, view)}
        onOpenInEditor={onOpenInEditor}
        onClose={() => onClose(tab.id)}
      />
    );
  };

  return <section ref={focusRef} tabIndex={-1} className="stage" aria-label="Stage" data-keybinding-context="stage" onKeyDown={onKeyDown}>
    <div className="stage-strip">
      <StageTabs
        tabs={stage.tabs}
        activeId={stage.activeId}
        splitId={beside?.id}
        onSplit={stageTabs?.split}
        changedPaths={changedPaths}
        registry={registry}
        onActivate={onActivate}
        onClose={onClose}
        onPin={onPin}
        onUnpin={onUnpin}
        onCloseOthers={onCloseOthers}
        onCloseToRight={onCloseToRight}
      />
      <div className="stage-strip-actions">
        {tools}
        {maximize ? <>
          <span className="stage-strip-separator" aria-hidden />
          <button
            type="button"
            className="stage-tool"
            aria-pressed={maximize.maximized}
            aria-label={maximize.label ?? (maximize.maximized ? "Show chat beside the stage" : "Maximize stage")}
            {...tooltipProps(maximize.label ?? (maximize.maximized ? "Show chat beside the stage" : "Maximize stage"), { side: "bottom" })}
            onClick={maximize.onToggle}
          >{maximize.maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}</button>
        </> : null}
      </div>
    </div>
    {beside ? <div className="stage-split">{pane(current)}{pane(beside)}</div> : pane(current)}
    {dropping ? <div className="stage-split-drop"><PanelRight size={16} />Drop to split</div> : null}
  </section>;
}
