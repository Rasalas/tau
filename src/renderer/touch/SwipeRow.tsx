import { useEffect, useRef, type ReactNode } from "react";
import type { PanelIconComponent } from "../components/PanelIcon";
import {
  LONG_PRESS_MS,
  swipeAxis,
  swipeCommitDistance,
  swipeOffset,
  swipeRelease,
  swipeTrayWidth,
  type SwipeAxis,
} from "./swipe-gesture";

export interface SwipeAction {
  id: string;
  label: string;
  Icon: PanelIconComponent;
  /** `primary` is the first action, the one a full swipe runs. */
  tone: "primary" | "secondary";
  run(): void;
}

interface Drag {
  pointerId: number;
  x: number;
  y: number;
  start: number;
  axis: SwipeAxis;
  offset: number;
  committing: boolean;
}

/**
 * A list row whose actions sit behind its trailing edge. A finger drags the
 * row left: a short swipe leaves the tray open, a long one runs the first
 * action. A press that rests is a long press, which the list answers with
 * every action at once. The browser keeps vertical scrolling (`pan-y`).
 */
export function SwipeRow({ actions, open, onOpenChange, onLongPress, className, children }: {
  actions: readonly SwipeAction[];
  open: boolean;
  onOpenChange(open: boolean): void;
  onLongPress(): void;
  className?: string;
  children: ReactNode;
}) {
  const row = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | undefined>(undefined);
  const pressTimer = useRef<number | undefined>(undefined);
  // A drag or a long press may end in a click the row must not treat as a tap;
  // only one that follows at once, since a moved finger usually sends none.
  const consumed = useRef(false);
  const swallowUntil = useRef(0);
  const tray = swipeTrayWidth(actions.length);
  // A row not laid out yet (or in a test) is as wide as the window.
  const rowWidth = () => row.current?.clientWidth || window.innerWidth;

  const place = (offset: number, animate: boolean) => {
    const element = content.current;
    if (!element) return;
    element.style.transition = animate ? "" : "none";
    element.style.transform = offset === 0 ? "" : `translateX(${offset}px)`;
    row.current?.style.setProperty("--swipe-reveal", String(tray === 0 ? 0 : Math.min(1, -offset / tray)));
  };
  useEffect(() => { if (!drag.current) place(open ? -tray : 0, true); });

  const cancelPress = () => { window.clearTimeout(pressTimer.current); pressTimer.current = undefined; };
  useEffect(() => cancelPress, []);

  const release = () => {
    const current = drag.current;
    drag.current = undefined;
    cancelPress();
    if (consumed.current) { consumed.current = false; swallowUntil.current = performance.now() + 350; }
    if (!current || current.axis !== "horizontal") return;
    row.current?.removeAttribute("data-committing");
    const width = rowWidth();
    const result = swipeRelease(current.offset, tray, width);
    place(result === "open" ? -tray : 0, true);
    if (result === "commit") { onOpenChange(false); actions[0]?.run(); }
    else onOpenChange(result === "open");
  };

  return <div
    ref={row}
    className={["swipe-row", open ? "open" : "", className ?? ""].filter(Boolean).join(" ")}
    onPointerDown={(event) => {
      if (event.button !== 0 || (event.target as Element).closest(".swipe-tray")) return;
      consumed.current = false;
      drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, start: open ? -tray : 0, axis: "pending", offset: open ? -tray : 0, committing: false };
      // A long press on something with a label of its own shows that label instead.
      if ((event.target as Element).closest("[data-tooltip]")) return;
      cancelPress();
      pressTimer.current = window.setTimeout(() => {
        pressTimer.current = undefined;
        drag.current = undefined;
        consumed.current = true;
        onLongPress();
      }, LONG_PRESS_MS);
    }}
    onPointerMove={(event) => {
      const current = drag.current;
      if (!current || current.pointerId !== event.pointerId) return;
      const dx = event.clientX - current.x;
      const dy = event.clientY - current.y;
      if (current.axis === "pending") {
        current.axis = swipeAxis(dx, dy);
        if (current.axis === "pending") return;
        cancelPress();
        if (current.axis === "vertical" || tray === 0) { drag.current = undefined; return; }
        consumed.current = true;
        row.current?.setPointerCapture?.(event.pointerId);
      }
      const width = rowWidth();
      current.offset = swipeOffset(current.start, dx, width);
      const committing = -current.offset >= swipeCommitDistance(tray, width);
      if (committing !== current.committing) {
        current.committing = committing;
        row.current?.toggleAttribute("data-committing", committing);
        if (committing) navigator.vibrate?.(8);
      }
      place(current.offset, false);
    }}
    onPointerUp={release}
    // After a long press or a drag, no emulated mouse press may land on what opened under the finger.
    onTouchEnd={(event) => { if (performance.now() < swallowUntil.current && event.cancelable) event.preventDefault(); }}
    onPointerCancel={() => { drag.current = undefined; cancelPress(); place(open ? -tray : 0, true); }}
    onContextMenu={(event) => { event.preventDefault(); cancelPress(); drag.current = undefined; onLongPress(); }}
    onClickCapture={(event) => {
      // The tray's own buttons are never where a gesture ends.
      if ((event.target as Element).closest(".swipe-tray")) return;
      if (performance.now() < swallowUntil.current) { swallowUntil.current = 0; event.preventDefault(); event.stopPropagation(); return; }
      // With the tray open, a tap on the row closes it rather than acting.
      if (open) { event.preventDefault(); event.stopPropagation(); onOpenChange(false); }
    }}
  >
    <div className="swipe-tray" aria-hidden={!open} style={{ width: tray }}>
      {actions.map((action) => <button
        key={action.id}
        type="button"
        className={`swipe-action ${action.tone}`}
        tabIndex={open ? 0 : -1}
        onClick={() => { onOpenChange(false); action.run(); }}
      >
        <i><action.Icon size={15} /></i>
        <span>{action.label}</span>
      </button>)}
    </div>
    <div ref={content} className="swipe-row-content">{children}</div>
  </div>;
}
