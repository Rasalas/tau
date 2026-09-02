import { PanelRight, PanelRightClose } from "lucide-react";
import type { HostSnapshot } from "../../shared/contracts";
import type { ExtensionRegistry, WorkbenchActions } from "../extension-system";
import { shortenPath } from "../path-display";
import { Region } from "./Regions";
import { WindowControlsInset } from "./WindowControlsInset";

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
}: {
  cwd?: string;
  dockOpen: boolean;
  registry: ExtensionRegistry;
  snapshot?: HostSnapshot;
  actions: WorkbenchActions;
  onToggleDock(): void;
}) {
  return (
    <header className="title-bar">
      <WindowControlsInset />
      <div className="title-identity">
        <strong>{workspaceName(cwd)}</strong>
        <span title={cwd}>{parentPath(cwd)}</span>
      </div>
      <div className="title-spacer" />

      <Region registry={registry} placement="title-bar" snapshot={snapshot} actions={actions} />

      <button
        className="chrome-ghost glyph"
        title={dockOpen ? "Hide panel" : "Show panel"}
        aria-label={dockOpen ? "Hide panel" : "Show panel"}
        onClick={onToggleDock}
      >
        {dockOpen ? <PanelRightClose size={15} /> : <PanelRight size={15} />}
      </button>
    </header>
  );
}
