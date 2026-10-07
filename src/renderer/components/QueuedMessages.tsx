import { useRef, useState } from "react";
import { ArrowUp, ChevronDown, ChevronUp, Clock, GripVertical, X } from "lucide-react";
import type { UiQueuedMessage } from "../../shared/contracts";
import { tooltipProps } from "./ui/Tooltip";
import { WakeIcon } from "./WakeLine";

/** A wake waits as one quiet row: it never steers into a turn, and dropping it puts nothing in the composer. */
function QueuedWake({ entry, held, onDrop }: { entry: UiQueuedMessage & { wake: NonNullable<UiQueuedMessage["wake"]> }; held: boolean; onDrop(): void }) {
  return <li className="queued-message queued-wake" aria-label={`Wake waiting: ${entry.wake.label}`}>
    <WakeIcon source={entry.wake.source} size={13} />
    <span className="queued-wake-label">{entry.wake.label}</span>
    <span className="queued-message-status" {...tooltipProps(held ? "Held with the queue until you send" : "Wakes wait for the current turn; they never interrupt it.")}>
      <Clock size={12} />{held ? "Held" : "Waits for the turn"}
    </span>
    <button type="button" aria-label="Drop this wake" {...tooltipProps("Drop this wake")} onClick={onDrop}><X size={14} /></button>
  </li>;
}

/**
 * Messages sent during a run wait at the end of the conversation as dashed
 * bubbles: the arrow sends one now, the X puts it back into
 * the composer. The up/down buttons and grip (or ⌥↑/⌥↓ on it) reorder them. The host keeps
 * the queue, so it survives a restart; a restored one is held for the user.
 */
export function QueuedMessages({ queue, streaming, held = false, steerShortcut, onSteer, onReturn, onReorder }: {
  queue: readonly UiQueuedMessage[];
  streaming: boolean;
  /** A restart, a stop or a limit held the queue: nothing leaves until the user sends. */
  held?: boolean;
  /** The label of `thread.steerQueuedMessage`, for the oldest one. */
  steerShortcut?: string;
  onSteer(id: string): void;
  onReturn(id: string): void;
  onReorder(id: string, toIndex: number): void;
}) {
  // Only a drag that starts on the grip reorders; text drags inside a bubble do not.
  const armed = useRef<string | undefined>(undefined);
  const [dragging, setDragging] = useState<string>();
  if (queue.length === 0) return null;
  return (
    <ol className="queued-messages" aria-label="Queued messages">
      {queue.map((entry, index) => {
        if (entry.wake) return <QueuedWake key={entry.id} entry={entry as UiQueuedMessage & { wake: NonNullable<UiQueuedMessage["wake"]> }} held={held} onDrop={() => onReturn(entry.id)} />;
        const files = entry.attachments;
        const status = held
          ? "Held: sends after your next message, or send it now"
          : index === 0
            ? streaming ? "Sends when the turn ends" : "Sends next"
            : "Sends after the messages above it";
        const send = streaming ? "Send now, into the running turn" : "Send now";
        return (
          <li
            key={entry.id}
            className={`queued-message${dragging === entry.id ? " dragging" : ""}`}
            draggable
            onDragStart={(event) => {
              if (armed.current !== entry.id) { event.preventDefault(); return; }
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", entry.id);
              setDragging(entry.id);
            }}
            onDragOver={(event) => { if (dragging) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } }}
            onDrop={(event) => {
              if (!dragging) return;
              event.preventDefault();
              if (dragging !== entry.id) onReorder(dragging, index);
              armed.current = undefined;
              setDragging(undefined);
            }}
            onDragEnd={() => { armed.current = undefined; setDragging(undefined); }}
          >
            {entry.text.trim() ? <p>{entry.text.trim()}</p> : null}
            {files > 0 ? <small>{files} attachment{files === 1 ? "" : "s"}</small> : null}
            <footer>
              <button
                type="button"
                className="queued-message-grip"
                aria-label={`Reorder queued message ${index + 1} of ${queue.length}`}
                {...tooltipProps("Drag to reorder — ⌥↑ / ⌥↓ also moves it")}
                onPointerDown={() => { armed.current = entry.id; }}
                onPointerUp={() => { armed.current = undefined; }}
                onKeyDown={(event) => {
                  if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
                  event.preventDefault();
                  onReorder(entry.id, event.key === "ArrowUp" ? index - 1 : index + 1);
                }}
              ><GripVertical size={13} /></button>
              {queue.length > 1 ? <>
                <button type="button" aria-label="Move queued message up" disabled={index === 0} {...tooltipProps("Move earlier in the queue")} onClick={() => onReorder(entry.id, index - 1)}>
                  <ChevronUp size={14} />
                </button>
                <button type="button" aria-label="Move queued message down" disabled={index === queue.length - 1} {...tooltipProps("Move later in the queue")} onClick={() => onReorder(entry.id, index + 1)}>
                  <ChevronDown size={14} />
                </button>
              </> : null}
              <span className="queued-message-status" {...tooltipProps(status)}><Clock size={12} />{held ? "Held" : "Queued"}{entry.fromThreadId ? " · from another thread" : ""}</span>
              <span className="spacer" />
              <button type="button" aria-label="Send now" {...tooltipProps(send, index === 0 && steerShortcut ? { shortcut: steerShortcut } : undefined)} onClick={() => onSteer(entry.id)}>
                <ArrowUp size={14} />
              </button>
              <button type="button" aria-label="Cancel and return to the composer" {...tooltipProps("Cancel and return to the composer")} onClick={() => onReturn(entry.id)}>
                <X size={14} />
              </button>
            </footer>
          </li>
        );
      })}
    </ol>
  );
}
