import { PanelLeft, Plus, Search } from "lucide-react";
import { READ_ONLY_REASON } from "../../shared/host-method-access";
import type { ExtensionRegistry, WorkbenchActions } from "../extension-system";
import { tooltipProps } from "./ui/Tooltip";

/** The rail's toggle, search and "+" in the title bar while the sidebar is closed, where its toggle was. */
export function SidebarClosedControls({ actions, registry, readOnly }: { actions: WorkbenchActions; registry: ExtensionRegistry; readOnly: boolean }) {
  return <div className="sidebar-closed-controls">
    {actions.toggleSidebar ? <button type="button" className="stage-tool" aria-label="Show sidebar"
      {...tooltipProps("Show sidebar", { side: "bottom", shortcut: registry.keybindingLabel("workbench.toggle-sidebar") })}
      onClick={actions.toggleSidebar}><PanelLeft size={16} /></button> : null}
    <button type="button" className="stage-tool" aria-label="Search"
      {...tooltipProps("Search", { side: "bottom", shortcut: registry.keybindingLabel("runtime.command-palette") })}
      onClick={() => actions.openCommandPalette()}><Search size={15} /></button>
    <button type="button" className="stage-tool" aria-label="New thread" disabled={readOnly}
      {...tooltipProps(readOnly ? READ_ONLY_REASON : "New thread", { side: "bottom", ...(readOnly ? {} : { shortcut: registry.keybindingLabel("runtime.new-session") }) })}
      onClick={() => actions.newSession()}><Plus size={16} /></button>
  </div>;
}
