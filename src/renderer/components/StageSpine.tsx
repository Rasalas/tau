import { useState, type ReactNode } from "react";
import { Bot, Ellipsis, Server, SquareDashed } from "lucide-react";
import type { StageTab } from "../../workbench/stage";
import type { ExtensionRegistry, PanelContribution } from "../extension-system";
import { Menu } from "../deferred-surfaces";
import { FileKindIcon } from "./FileKindIcon";
import { PanelIcon } from "./PanelIcon";
import { tooltipProps, type TooltipOptions } from "./ui/Tooltip";

function fileName(path: string): string {
  return path.split(/[\\/]/u).filter(Boolean).at(-1) ?? path;
}

/** A tab's glyph and name as the strip draws it; a thread tab's title comes from the index where it is shown. */
export function stageTabGlyph(tab: StageTab, registry?: ExtensionRegistry, size = 14): { icon: ReactNode; label: string } {
  if (tab.kind === "file") return { icon: <FileKindIcon name={fileName(tab.path)} size={size} />, label: fileName(tab.path) };
  if (tab.kind === "thread") return { icon: tab.machine ? <Server size={size} /> : <Bot size={size} />, label: "Thread" };
  if (tab.kind === "panel") {
    const panel = registry?.getPanels().find((entry) => entry.id === tab.panelId);
    return { icon: <PanelIcon Icon={panel?.Icon} size={size} />, label: panel?.label ?? tab.panelId };
  }
  const Icon = registry?.getStageTabKind(tab.tabKind)?.Icon ?? SquareDashed;
  return { icon: <Icon size={size} />, label: tab.title };
}

/**
 * The tools the stage opens: a button for each panel that asked for one, the
 * rest behind "More tools", at the right end of the stage's tab strip.
 */
export function StageTools({ panels, shown, onOpen, side = "bottom" }: {
  panels: readonly PanelContribution[];
  /** Panels whose tab is in front of a shown stage, or whose drawer is open. */
  shown: ReadonlySet<string>;
  onOpen(id: string): void;
  side?: TooltipOptions["side"];
}) {
  const [more, setMore] = useState(false);
  const buttons = panels.filter((panel) => panel.stageButton);
  const rest = panels.filter((panel) => !panel.stageButton);
  return <>
    {buttons.map((panel) => <button
      key={panel.id}
      type="button"
      className="stage-tool"
      aria-label={panel.label}
      aria-pressed={shown.has(panel.id)}
      {...tooltipProps(panel.label, { side })}
      onClick={() => onOpen(panel.id)}
    ><PanelIcon Icon={panel.Icon} size={14} /></button>)}
    {rest.length > 0 ? <span className="menu-anchor">
      <button
        type="button"
        className="stage-tool"
        aria-label="More tools"
        aria-haspopup="menu"
        aria-expanded={more}
        {...tooltipProps("More tools", { side })}
        onClick={() => setMore((open) => !open)}
      ><Ellipsis size={14} /></button>
      {more ? <Menu
        align="right"
        label="More tools"
        items={rest.map((panel) => ({ id: panel.id, label: panel.label, icon: <PanelIcon Icon={panel.Icon} size={15} />, selected: shown.has(panel.id) }))}
        onSelect={(id) => { setMore(false); onOpen(id); }}
        onClose={() => setMore(false)}
      /> : null}
    </span> : null}
  </>;
}
