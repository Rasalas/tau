import type { ReactNode } from "react";
import type { PanelIconComponent } from "../components/PanelIcon";
import { Sheet } from "./Sheet";

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
export function ActionSheet({ title, head, summary, actions, onClose }: {
  title: string;
  /** The subject drawn over the actions in place of the title (a thread's row, design 1x). */
  head?: ReactNode;
  /** A line about the subject above the actions (a thread's cost). */
  summary?: string | undefined;
  actions: readonly SheetAction[];
  onClose(): void;
}) {
  const ordered = [...actions.filter((action) => !action.destructive), ...actions.filter((action) => action.destructive)];
  return <Sheet title={title} className={head ? "action-sheet has-head" : "action-sheet"} onClose={onClose}>
    {head}
    {summary ? <p className="action-sheet-summary">{summary}</p> : null}
    <div className="action-sheet-list">
      {ordered.map((action) => <button
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
  </Sheet>;
}
