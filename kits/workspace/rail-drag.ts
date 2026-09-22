import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { ThreadRailDrop, ThreadRailOrganizer, ThreadRailSection } from "./protocol.js";

/** What the pointer is over: a row (and which half of it), or a section's heading. */
export interface RailPointerTarget {
  sectionId: string;
  threadId?: string;
  /** The lower half of the row. */
  after?: boolean;
}

export interface RailDragState {
  threadId: string;
  drop?: ThreadRailDrop;
  label?: string;
  x: number;
  y: number;
}

/** A pointer that travels less than this is a click, not a drag. */
const DRAG_THRESHOLD = 6;
/** How long after a drop the click it produces is swallowed. */
const CLICK_GRACE_MS = 400;

/**
 * Where a thread dropped on `over` lands. A heading takes it to the top of its
 * section; a row puts it before or after that row; the thread's own row keeps
 * it where it is.
 */
export function railDropAt(sections: readonly ThreadRailSection[], over: RailPointerTarget, dragged: string): ThreadRailDrop {
  const all = (sections.find((section) => section.id === over.sectionId)?.threads ?? []).map((thread) => thread.id);
  const others = all.filter((id) => id !== dragged);
  const at = (index: number): ThreadRailDrop => {
    const before = others[index];
    return before ? { sectionId: over.sectionId, beforeThreadId: before } : { sectionId: over.sectionId };
  };
  if (!over.threadId) return at(0);
  if (over.threadId === dragged) return at(all.indexOf(dragged));
  const index = others.indexOf(over.threadId);
  return at(index < 0 ? others.length : over.after ? index + 1 : index);
}

function targetAt(x: number, y: number): RailPointerTarget | undefined {
  const element = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-rail-thread], [data-rail-heading]");
  if (!element) return undefined;
  const heading = element.dataset.railHeading;
  if (heading) return { sectionId: heading };
  const sectionId = element.dataset.railSection;
  if (!sectionId) return undefined;
  const rect = element.getBoundingClientRect();
  return { sectionId, threadId: element.dataset.railThread, after: y > rect.top + rect.height / 2 };
}

/**
 * Pointer-driven reordering for the rail. It works out where a thread would
 * land and asks the organizer what that means; the organizer decides.
 */
export function useRailDrag(organizer: ThreadRailOrganizer | undefined, sections: readonly ThreadRailSection[]) {
  const [drag, setDrag] = useState<RailDragState>();
  const pressed = useRef<{ threadId: string; x: number; y: number } | undefined>(undefined);
  const dragging = useRef<RailDragState | undefined>(undefined);
  const suppressClickUntil = useRef(0);
  const latest = useRef({ organizer, sections });
  latest.current = { organizer, sections };

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (!organizer || event.button !== 0) return;
    const target = event.target as Element;
    if (target.closest(".thread-settle")) return;
    const row = target.closest<HTMLElement>("[data-rail-thread]");
    const threadId = row?.dataset.railThread;
    if (threadId) pressed.current = { threadId, x: event.clientX, y: event.clientY };
  }, [organizer]);

  useEffect(() => {
    if (!organizer) return;
    const set = (next: RailDragState | undefined) => { dragging.current = next; setDrag(next); };
    const move = (event: PointerEvent) => {
      const start = pressed.current;
      if (!start) return;
      if (!dragging.current && Math.hypot(event.clientX - start.x, event.clientY - start.y) < DRAG_THRESHOLD) return;
      const { organizer: current, sections: drawn } = latest.current;
      if (!current) return;
      const over = targetAt(event.clientX, event.clientY);
      const drop = over ? railDropAt(drawn, over, start.threadId) : dragging.current?.drop;
      const label = drop ? current.dropLabel(start.threadId, drop) : undefined;
      set({ threadId: start.threadId, x: event.clientX, y: event.clientY, ...(drop && label ? { drop, label } : {}) });
    };
    const up = () => {
      const state = dragging.current;
      pressed.current = undefined;
      if (!state) return;
      set(undefined);
      suppressClickUntil.current = Date.now() + CLICK_GRACE_MS;
      if (state.drop && state.label) latest.current.organizer?.drop(state.threadId, state.drop);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !dragging.current) return;
      event.stopPropagation();
      pressed.current = undefined;
      set(undefined);
    };
    // A drop ends in a click on whatever row it was released over; that click is not a selection.
    const click = (event: MouseEvent) => {
      if (Date.now() > suppressClickUntil.current) return;
      suppressClickUntil.current = 0;
      event.stopPropagation();
      event.preventDefault();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    window.addEventListener("keydown", key, true);
    window.addEventListener("click", click, true);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("click", click, true);
    };
  }, [organizer]);

  return { drag, onPointerDown };
}
