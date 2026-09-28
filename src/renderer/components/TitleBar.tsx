import { useRef, useState, type ReactNode } from "react";
import { ChevronLeft, Ellipsis } from "lucide-react";
import type { HostSnapshot } from "../../shared/contracts";
import type { ExtensionRegistry, WorkbenchActions } from "../extension-system";
import { PanelIcon, type PanelIconComponent } from "./PanelIcon";
import { Region } from "./Regions";
import { HostLinkIndicator } from "../host-connection-status";
import { tooltipProps } from "./ui/Tooltip";
import { Popover } from "../deferred-surfaces";

/** A panel a compact layout opens over the thread, from its glyph in the bar. */
export interface SheetToggle {
  id: string;
  label: string;
  Icon?: PanelIconComponent;
  open: boolean;
  onToggle(): void;
}

/** A phone's panels behind one More button at the bar's end, as a menu anchored to it. */
function SheetMenu({ sheets }: { sheets: readonly SheetToggle[] }) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return <>
    <button
      ref={trigger}
      className="chrome-ghost glyph"
      aria-label="More"
      aria-haspopup="menu"
      aria-expanded={open}
      {...tooltipProps("More", { side: "bottom" })}
      onClick={() => setOpen((held) => !held)}
    ><Ellipsis size={16} /></button>
    {open ? <Popover anchor={trigger} side="bottom" align="end" label="More" className="touch-popover touch-menu" onClose={() => setOpen(false)}>
      <div role="menu" aria-label="Panels">
        {sheets.map((sheet) => <button
          key={sheet.id}
          type="button"
          role="menuitemcheckbox"
          aria-checked={sheet.open}
          onClick={() => { setOpen(false); sheet.onToggle(); }}
        ><PanelIcon Icon={sheet.Icon} size={17} />{sheet.label}</button>)}
      </div>
    </Popover> : null}
  </>;
}

/**
 * A phone's bar over its chat: back to the list, the thread's title with its
 * details under it (the workbench design's 1n), what kits place in
 * `title-bar`, and the panels it opens as sheets — the first as its glyph, the
 * rest behind More, anchored at the bar's end. Everywhere else the
 * conversation's own header takes this place.
 */
export function TitleBar({
  registry,
  snapshot,
  actions,
  thread,
  details,
  onBack,
  sheets = [],
  foldSheets = false,
}: {
  registry: ExtensionRegistry;
  snapshot?: HostSnapshot;
  actions: WorkbenchActions;
  /** The thread's title menu, or the draft's name. */
  thread?: ReactNode;
  /** Branch, model, turn and cost under the title. */
  details?: ReactNode;
  /** The chat is a screen over the thread list, and this goes back to it. */
  onBack?(): void;
  /** Panels the phone draws over the thread. */
  sheets?: readonly SheetToggle[];
  /** Two or more sheets: the first keeps its glyph, the rest fold into one More menu. */
  foldSheets?: boolean;
}) {
  const [first, ...rest] = sheets;
  const folded = foldSheets && rest.length > 1;
  const glyphs = folded && first ? [first] : sheets;
  return (
    <header className="title-bar">
      <div className="title-lead">
        {onBack ? <button
          className="chrome-ghost glyph"
          aria-label="Back to threads"
          onClick={onBack}
        ><ChevronLeft size={15} /></button> : null}
      </div>
      <div className="title-heading">
        <div className="title-heading-name">{thread}</div>
        {details}
      </div>
      <HostLinkIndicator />

      <Region registry={registry} placement="title-bar" snapshot={snapshot} actions={actions} />

      {glyphs.map((sheet) => <button
        key={sheet.id}
        className="chrome-ghost glyph"
        aria-pressed={sheet.open}
        aria-label={sheet.label}
        {...tooltipProps(sheet.label, { side: "bottom" })}
        onClick={sheet.onToggle}
      ><PanelIcon Icon={sheet.Icon} size={16} /></button>)}
      {folded ? <SheetMenu sheets={rest} /> : null}
    </header>
  );
}
