import { ListTree, PanelRight, PanelRightClose } from "lucide-react";
import type { HostSnapshot } from "../../shared/contracts";
import type { ExtensionRegistry, WorkbenchActions } from "../extension-system";
import { shortenPath } from "../path-display";
import { Region } from "./Regions";
import { WindowControlsInset } from "./WindowControlsInset";
import { tooltipProps } from "./ui/Tooltip";

function workspaceName(cwd?: string): string {
  return cwd?.split(/[\\/]/u).filter(Boolean).at(-1) ?? "workspace";
}

function parentPath(cwd?: string): string {
  if (!cwd) return "starting host…";
  const parent = cwd.slice(0, cwd.lastIndexOf("/"));
  return parent ? shortenPath(parent, 34) : "/";
}

/** Window chrome and the project's identity; everything else in the bar is a region. */
export function TitleBar({
  cwd,
  dockOpen,
  registry,
  snapshot,
  actions,
  onToggleDock,
  onOpenThreads,
  hasDock = true,
}: {
  cwd?: string;
  dockOpen: boolean;
  registry: ExtensionRegistry;
  snapshot?: HostSnapshot;
  actions: WorkbenchActions;
  onToggleDock(): void;
  /** Set only where the thread list is a sheet rather than a column. */
  onOpenThreads?(): void;
  /** False when no extension registered a panel: there is no dock to show or hide. */
  hasDock?: boolean;
}) {
  return (
    <header className="title-bar">
      <WindowControlsInset />
      {onOpenThreads ? <button
        className="chrome-ghost glyph"
        {...tooltipProps("Threads", { side: "bottom" })}
        aria-label="Threads"
        onClick={onOpenThreads}
      ><ListTree size={15} /></button> : null}
      <div className="title-identity">
        <strong>{workspaceName(cwd)}</strong>
        <span {...tooltipProps(cwd, { side: "bottom", variant: "code" })}>{parentPath(cwd)}</span>
      </div>
      <div className="title-spacer" />

      <Region registry={registry} placement="title-bar" snapshot={snapshot} actions={actions} />

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
