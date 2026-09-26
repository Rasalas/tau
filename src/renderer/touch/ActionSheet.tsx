import { useLayoutEffect, useRef } from "react";
import { X } from "lucide-react";
import { Dialog } from "../components/ui/Dialog";
import type { PanelIconComponent } from "../components/PanelIcon";
import { useSheetDrag } from "./sheet-drag";

export interface SheetAction {
  id: string;
  label: string;
  Icon?: PanelIconComponent | undefined;
  destructive?: boolean | undefined;
  /** Why the action cannot run now; set, the row shows it and stays disabled. */
  disabledReason?: string | undefined;
  /** A second line, e.g. a project's path. */
  detail?: string | undefined;
  /** The choice in force, where the sheet picks one of several. */
  pressed?: boolean | undefined;
  run(): void;
}

/**
 * Every action on one thing, as a sheet from the bottom edge: what a long
 * press opens where a desktop would open a context menu. Destructive actions
 * come last, apart from the rest. It closes with its X, Escape, the scrim or a
 * pull down on anything but a button.
 */
export function ActionSheet({ title, actions, onClose }: {
  title: string;
  actions: readonly SheetAction[];
  onClose(): void;
}) {
  const ordered = [...actions.filter((action) => !action.destructive), ...actions.filter((action) => action.destructive)];
  return <Dialog label={title} className="action-sheet" onClose={onClose}>
    <ActionSheetBody title={title} actions={ordered} onClose={onClose} />
  </Dialog>;
}

function ActionSheetBody({ title, actions, onClose }: { title: string; actions: readonly SheetAction[]; onClose(): void }) {
  const body = useRef<HTMLDivElement>(null);
  // The dialog's own surface is the sheet a pull moves.
  const sheet = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => { sheet.current = body.current?.closest<HTMLElement>(".action-sheet") ?? null; }, []);
  useSheetDrag(sheet, onClose);
  return <div ref={body} className="action-sheet-body">
    <header className="touch-sheet-header">
      <span className="touch-sheet-grip" aria-hidden="true" />
      <strong>{title}</strong>
      <button type="button" className="touch-icon-button" aria-label="Close" onClick={onClose}><X size={18} /></button>
    </header>
    <div className="action-sheet-list">
      {actions.map((action) => <button
        key={action.id}
        type="button"
        className={action.destructive ? "destructive" : undefined}
        disabled={Boolean(action.disabledReason)}
        aria-pressed={action.pressed}
        onClick={() => { onClose(); action.run(); }}
      >
        <i aria-hidden="true">{action.Icon ? <action.Icon size={17} /> : null}</i>
        <span>{action.label}{action.detail ? <small>{action.detail}</small> : null}{action.disabledReason ? <small>{action.disabledReason}</small> : null}</span>
      </button>)}
    </div>
  </div>;
}
