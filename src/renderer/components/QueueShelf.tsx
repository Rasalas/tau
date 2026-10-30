import { useContext, useState } from "react";
import { AlarmClock, ArrowUp, ArrowUpToLine, ChevronDown, CornerUpRight, ListPlus, Pencil, X } from "lucide-react";
import type { UiQueuedMessage } from "../../shared/contracts";
import { PlanSheet } from "../deferred-surfaces";
import { useCompactForm } from "../use-layout-profile";
import { tooltipProps } from "./ui/Tooltip";
import { shortWhen } from "./when-pick";
import { WakeIcon } from "./WakeLine";
import { WorkbenchShellContext } from "../workbench-context";
import "./queue-shelf.css";

/** What waits, in the order it leaves: the line of the queue, then planned messages by their time. */
export function queueOrder(queue: readonly UiQueuedMessage[]): UiQueuedMessage[] {
  const line = queue.filter((entry) => entry.deliverAt === undefined);
  const planned = queue.filter((entry) => entry.deliverAt !== undefined).sort((a, b) => a.deliverAt! - b.deliverAt!);
  return [...line, ...planned];
}

const preview = (entry: UiQueuedMessage) => entry.wake?.label ?? (entry.text.trim() || `${entry.attachments} attachment${entry.attachments === 1 ? "" : "s"}`);

/**
 * "Next" over the composer (design G1): a tab that tucks under the composer's
 * top edge. It shows the message that leaves next, two lines of it, with
 * Steer now (Send now at rest) and Edit; "Then N more" opens the rest, one row
 * each, where Move to front, Steer and Remove wait under the pointer. A click
 * on a message's text puts it back into the composer to edit; a planned one's
 * time plans it for another. The host keeps the queue, so it survives a
 * restart; a restored one is held until the user sends.
 */
export function QueueShelf({ queue, streaming, held = false, resumeAt, steerShortcut: shortcut, onSteer, onEdit, onRemove, onReorder, onPlan }: {
  queue: readonly UiQueuedMessage[];
  streaming: boolean;
  /** A restart, a stop or a limit held the queue: nothing in its line leaves until the user sends. */
  held?: boolean;
  /** A usage limit's scheduled resume: the line leaves with it. */
  resumeAt?: number | undefined;
  /** The label of `thread.steerQueuedMessage`, for the message that leaves next; the workbench's own by default. */
  steerShortcut?: string | undefined;
  onSteer(id: string): void;
  /** Takes it back into the composer. */
  onEdit(id: string): void;
  onRemove(id: string): void;
  /** Move to front calls it with index 0. */
  onReorder?: ((id: string, toIndex: number) => void) | undefined;
  onPlan?: ((id: string, deliverAt: number) => void) | undefined;
}) {
  const shell = useContext(WorkbenchShellContext);
  const steerShortcut = shortcut ?? shell?.registry.keybindingLabel("thread.steerQueuedMessage");
  const [open, setOpen] = useState(false);
  const [planning, setPlanning] = useState<UiQueuedMessage>();
  const phone = useCompactForm("compact") === "single";
  const ordered = queueOrder(queue);
  const head = ordered[0];
  if (!head) return null;
  const rest = ordered.slice(1);
  const now = Date.now();
  const send = streaming ? "Steer now" : "Send now";
  const SendIcon = streaming ? CornerUpRight : ArrowUp;
  const status = head.deliverAt !== undefined
    ? `Planned · ${shortWhen(head.deliverAt, now)}`
    : head.wake ? "Next · a wake"
      : resumeAt !== undefined ? `Next · sends at ${shortWhen(resumeAt, now)}`
      : held ? "Held · sends after your next message"
        : streaming ? "Next · sends when the turn ends" : "Next · sends now";
  const planFor = (entry: UiQueuedMessage) => onPlan && entry.deliverAt !== undefined ? () => setPlanning(entry) : undefined;
  const headPlan = planFor(head);
  return (
    <section className={`queue-shelf${held ? " held" : ""}`} aria-label="Queued messages">
      <header>
        {head.deliverAt !== undefined ? <AlarmClock size={13} aria-hidden="true" /> : head.wake ? <WakeIcon source={head.wake.source} size={13} /> : <ListPlus size={13} aria-hidden="true" />}
        <b>{status}</b>
        {rest.length > 0 ? (
          <button type="button" className="queue-shelf-more" aria-expanded={open} onClick={() => setOpen((shown) => !shown)}>
            Then {rest.length} more<ChevronDown size={13} aria-hidden="true" />
          </button>
        ) : null}
      </header>
      <p
        className="queue-shelf-text"
        {...(head.wake ? {} : { onClick: () => { if (!window.getSelection()?.toString()) onEdit(head.id); } })}
      >{preview(head)}</p>
      <footer>
        <button type="button" className="queue-shelf-action primary" {...tooltipProps(streaming ? "Send it into the running turn" : "Send it now", steerShortcut ? { shortcut: steerShortcut } : undefined)} onClick={() => onSteer(head.id)}>
          <SendIcon size={13} aria-hidden="true" />{send}
        </button>
        {headPlan ? <button type="button" className="queue-shelf-action" onClick={headPlan}><AlarmClock size={13} aria-hidden="true" />Change time</button> : null}
        {head.wake ? null : <button type="button" className="queue-shelf-action" onClick={() => onEdit(head.id)}><Pencil size={13} aria-hidden="true" />Edit</button>}
        <span className="spacer" />
        <button type="button" className="queue-shelf-icon" aria-label={head.wake ? "Drop this wake" : "Remove from the queue"} {...tooltipProps(head.wake ? "Drop this wake" : "Remove")} onClick={() => onRemove(head.id)}><X size={14} /></button>
      </footer>
      {open && rest.length > 0 ? (
        <ol className="queue-shelf-rest">
          {rest.map((entry) => {
            const plan = planFor(entry);
            const inLine = entry.deliverAt === undefined && !entry.wake;
            return (
              <li key={entry.id} className="queue-shelf-row">
                {entry.deliverAt !== undefined ? <AlarmClock size={13} className="planned" aria-hidden="true" /> : entry.wake ? <WakeIcon source={entry.wake.source} size={13} /> : <ListPlus size={13} aria-hidden="true" />}
                {entry.wake
                  ? <span className="queue-shelf-row-text">{preview(entry)}</span>
                  : <button type="button" className="queue-shelf-row-text" aria-label={`Edit ${preview(entry)}`} onClick={() => onEdit(entry.id)}>{preview(entry)}</button>}
                <small className={entry.deliverAt !== undefined ? "planned" : ""}>{entry.deliverAt !== undefined ? shortWhen(entry.deliverAt, now) : "after that"}</small>
                <span className="queue-shelf-row-actions">
                  {inLine && onReorder ? <button type="button" className="queue-shelf-action" onClick={() => onReorder(entry.id, 0)}><ArrowUpToLine size={13} aria-hidden="true" />Move to front</button> : null}
                  {plan ? <button type="button" className="queue-shelf-action" onClick={plan}>Change time</button> : null}
                  <button type="button" className="queue-shelf-action primary" onClick={() => onSteer(entry.id)}><SendIcon size={13} aria-hidden="true" />{streaming ? "Steer" : "Send"}</button>
                  <button type="button" className="queue-shelf-icon" aria-label={entry.wake ? "Drop this wake" : "Remove from the queue"} onClick={() => onRemove(entry.id)}><X size={14} /></button>
                </span>
              </li>
            );
          })}
        </ol>
      ) : null}
      {planning && onPlan ? (
        <PlanSheet
          title="Change the time"
          confirmLabel="Save"
          sheet={phone}
          draft={{ text: planning.text, attachments: planning.attachments }}
          onPlan={(at) => { setPlanning(undefined); onPlan(planning.id, at); }}
          onClose={() => setPlanning(undefined)}
        />
      ) : null}
    </section>
  );
}
