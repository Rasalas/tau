import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Bot, Ellipsis, Server, SquareDashed } from "lucide-react";
import type { StageTab } from "../../workbench/stage";
import type { ExtensionRegistry, PanelContribution } from "../extension-system";
import { stageToolLayout } from "./stage-tool-layout";
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

const noActivity = () => false;
const noOpened: ReadonlySet<string> = new Set();

function ToolButton({ panel, shown, onOpen, side }: { panel: PanelContribution; shown: boolean; onOpen(id: string): void; side: TooltipOptions["side"] }) {
  const activity = (panel.useActivity ?? noActivity)(shown);
  const label = activity && !shown ? `${panel.label}, new activity` : panel.label;
  return <button type="button" className="stage-tool" aria-label={label} aria-pressed={shown}
    {...tooltipProps(label, { side })} onClick={() => onOpen(panel.id)}>
    <PanelIcon Icon={panel.Icon} size={14} />
    {activity && !shown ? <span className="stage-tool-activity" aria-hidden="true" /> : null}
  </button>;
}

/** Fixed tools and open panels, with the remaining tools in the overflow. */
export function StageTools({ panels, shown, opened = noOpened, onOpen, side = "bottom" }: {
  panels: readonly PanelContribution[];
  shown: ReadonlySet<string>;
  opened?: ReadonlySet<string>;
  onOpen(id: string): void;
  side?: TooltipOptions["side"];
}) {
  const [more, setMore] = useState(false);
  const surface = useRef<HTMLDivElement>(null);
  const [slots, setSlots] = useState(Infinity);
  const ideal = stageToolLayout(panels, opened, shown);
  const wanted = ideal.buttons.length + (ideal.rest.length > 0 ? 1 : 0);
  useLayoutEffect(() => {
    const element = surface.current;
    if (!element || typeof ResizeObserver === "undefined") return undefined;
    const update = () => {
      const width = element.getBoundingClientRect().width;
      const size = parseFloat(getComputedStyle(element).getPropertyValue("--stage-tool-size")) || 28;
      if (width > 0) setSlots(Math.max(1, Math.floor((width + 1) / (size + 1))));
    };
    const observer = new ResizeObserver(update);
    observer.observe(element);
    update();
    return () => observer.disconnect();
  }, [wanted]);
  const { buttons, rest } = stageToolLayout(panels, opened, shown, slots);
  return <div ref={surface} className="stage-tools" style={{ width: `calc(${wanted} * (var(--stage-tool-size) + 1px))` }}>
    {buttons.map((panel) => <ToolButton key={panel.id} panel={panel} shown={shown.has(panel.id)} onOpen={onOpen} side={side} />)}
    {rest.length > 0 ? <span className="menu-anchor">
      <button type="button" className="stage-tool" aria-label="More tools" aria-haspopup="menu" aria-expanded={more}
        {...tooltipProps("More tools", { side })} onClick={() => setMore((open) => !open)}><Ellipsis size={14} /></button>
      {more ? <Menu align="right" label="More tools"
        items={rest.map((panel) => ({ id: panel.id, label: panel.label, icon: <PanelIcon Icon={panel.Icon} size={15} />, selected: shown.has(panel.id) }))}
        onSelect={(id) => { setMore(false); onOpen(id); }} onClose={() => setMore(false)} /> : null}
    </span> : null}
  </div>;
}
