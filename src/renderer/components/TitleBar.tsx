import type { ReactNode } from "react";
import { ListTree, PanelBottom, PanelBottomClose, PanelRight, PanelRightClose } from "lucide-react";
import type { HostSnapshot } from "../../shared/contracts";
import type { ExtensionRegistry, WorkbenchActions } from "../extension-system";
import { Region } from "./Regions";
import { WindowControlsInset } from "./WindowControlsInset";
import { tooltipProps } from "./ui/Tooltip";

function workspaceName(cwd?: string): string {
  return cwd?.split(/[\\/]/u).filter(Boolean).at(-1) ?? "workspace";
}

/** A panel that draws below the conversation, and whether it is showing. */
export interface DrawerToggle {
  id: string;
  label: string;
  open: boolean;
  shortcut?: string;
  onToggle(): void;
}

/**
 * The window's one top bar, as in T3 Code: the traffic-light corner over the
 * sidebar, then project / thread as a breadcrumb over the conversation, then
 * the kits' actions and the panel toggles.
 */
export function TitleBar({
  cwd,
  dockOpen,
  registry,
  snapshot,
  actions,
  thread,
  drawers = [],
  onToggleDock,
  onOpenThreads,
  hasDock = true,
}: {
  cwd?: string;
  dockOpen: boolean;
  registry: ExtensionRegistry;
  snapshot?: HostSnapshot;
  actions: WorkbenchActions;
  /** The thread's part of the breadcrumb: its title menu, or the draft's name. */
  thread?: ReactNode;
  drawers?: readonly DrawerToggle[];
  onToggleDock(): void;
  /** Set only where the thread list is a sheet rather than a column. */
  onOpenThreads?(): void;
  /** False when no extension registered a panel: there is no dock to show or hide. */
  hasDock?: boolean;
}) {
  const project = workspaceName(cwd);
  return (
    <header className="title-bar">
      <div className="title-lead">
        <WindowControlsInset />
        {onOpenThreads ? <button
          className="chrome-ghost glyph"
          {...tooltipProps("Threads", { side: "bottom" })}
          aria-label="Threads"
          onClick={onOpenThreads}
        ><ListTree size={15} /></button> : null}
      </div>
      <nav className="title-breadcrumb" aria-label="Thread breadcrumb">
        <button
          type="button"
          className="chrome-ghost title-project"
          aria-label={`New thread in ${project}`}
          {...tooltipProps(cwd ?? "starting host…", { side: "bottom", variant: "code" })}
          onClick={() => actions.newSession(cwd ? { workspace: cwd } : undefined)}
        >{project}</button>
        {thread ? <><span className="title-separator" aria-hidden>/</span>{thread}</> : null}
      </nav>
      <div className="title-spacer" />

      <Region registry={registry} placement="title-bar" snapshot={snapshot} actions={actions} />

      {drawers.map((drawer) => <button
        key={drawer.id}
        className="chrome-ghost glyph"
        aria-pressed={drawer.open}
        aria-label={`Toggle ${drawer.label} drawer`}
        {...tooltipProps(`Toggle ${drawer.label} drawer`, { side: "bottom", shortcut: drawer.shortcut })}
        onClick={drawer.onToggle}
      >{drawer.open ? <PanelBottomClose size={15} /> : <PanelBottom size={15} />}</button>)}
      {hasDock ? <button
        className="chrome-ghost glyph"
        {...tooltipProps(dockOpen ? "Hide panel" : "Show panel", { side: "bottom", shortcut: registry.keybindingLabel?.("workbench.toggle-dock") })}
        aria-label={dockOpen ? "Hide panel" : "Show panel"}
        onClick={onToggleDock}
      >
        {dockOpen ? <PanelRightClose size={15} /> : <PanelRight size={15} />}
      </button> : null}
    </header>
  );
}
