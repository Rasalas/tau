import { useEffect, useRef, useState, type RefObject } from "react";

/** How far a gesture has to scroll the transcript back before the composer folds. */
export const COLLAPSE_DISTANCE_PX = 120;
/** A pause this long ends a gesture. */
const GESTURE_GAP_MS = 250;

export interface ScrollGesture { distance: number; at: number }

/**
 * Adds one wheel event to the gesture. Scrolling back through the transcript
 * accumulates; scrolling toward the end or pausing starts over. Answers
 * whether the gesture has gone far enough to fold the composer.
 */
export function scrollGestureStep(gesture: ScrollGesture, deltaY: number, now: number): boolean {
  if (deltaY >= 0 || now - gesture.at > GESTURE_GAP_MS) gesture.distance = 0;
  gesture.at = now;
  if (deltaY < 0) gesture.distance += -deltaY;
  return gesture.distance >= COLLAPSE_DISTANCE_PX;
}

const LINE_PX = 16;

/**
 * Folds the composer to its text line while the user scrolls back through the
 * transcript with the composer idle, and unfolds it when the keyboard comes
 * back to it or the transcript is scrolled to its end.
 */
export function useComposerCollapse({ enabled, idle, zoneRef }: {
  enabled: boolean;
  /** Nothing in the composer asks to stay open: one line, no open question, menu or popover; asked as the transcript scrolls. */
  idle(): boolean;
  zoneRef: RefObject<HTMLElement | null>;
}): { collapsed: boolean } {
  const [collapsed, setCollapsed] = useState(false);
  const touchScroll = useRef<{ scroller: HTMLElement; top: number; gesture: ScrollGesture } | undefined>(undefined);
  const idleRef = useRef(idle);
  idleRef.current = idle;
  useEffect(() => { if (!enabled) setCollapsed(false); }, [enabled]);

  useEffect(() => {
    if (!enabled) return undefined;
    const gesture: ScrollGesture = { distance: 0, at: 0 };
    const transcriptFor = (target: EventTarget | null) => {
      if (!(target instanceof Element)) return undefined;
      const scroller = target.closest<HTMLElement>(".transcript");
      const conversation = zoneRef.current?.closest(".conversation-column");
      return scroller && conversation && scroller.closest(".conversation-column") === conversation ? scroller : undefined;
    };
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey) return;
      const scroller = transcriptFor(event.target);
      if (!scroller) return;
      touchScroll.current = undefined;
      const delta = event.deltaY * (event.deltaMode === 1 ? LINE_PX : event.deltaMode === 2 ? scroller.clientHeight : 1);
      if (delta > 0 && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) {
        setCollapsed(false);
        return;
      }
      if (scrollGestureStep(gesture, delta, event.timeStamp) && idleRef.current() && scroller.scrollTop > 0) setCollapsed(true);
    };
    const onTouchStart = (event: TouchEvent) => {
      const scroller = transcriptFor(event.target);
      touchScroll.current = scroller ? { scroller, top: scroller.scrollTop, gesture: { distance: 0, at: event.timeStamp } } : undefined;
    };
    const onScroll = (event: Event) => {
      const scroller = transcriptFor(event.target);
      if (!scroller || event.target !== scroller) return;
      if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) {
        setCollapsed(false);
        if (touchScroll.current?.scroller === scroller) {
          touchScroll.current.top = scroller.scrollTop;
          touchScroll.current.gesture.distance = 0;
        }
        return;
      }
      const touch = touchScroll.current;
      if (!touch || touch.scroller !== scroller) return;
      const delta = scroller.scrollTop - touch.top;
      touch.top = scroller.scrollTop;
      if (scrollGestureStep(touch.gesture, delta, event.timeStamp) && idleRef.current()) setCollapsed(true);
    };
    document.addEventListener("wheel", onWheel, { capture: true, passive: true });
    document.addEventListener("touchstart", onTouchStart, { capture: true, passive: true });
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => {
      touchScroll.current = undefined;
      document.removeEventListener("wheel", onWheel, true);
      document.removeEventListener("touchstart", onTouchStart, true);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [enabled, zoneRef]);

  useEffect(() => {
    const zone = zoneRef.current;
    if (!zone) return undefined;
    // The field may keep the keyboard while folded; the next key or press unfolds it.
    const open = () => { touchScroll.current = undefined; setCollapsed(false); };
    const events = ["focusin", "keydown", "pointerdown"] as const;
    for (const type of events) zone.addEventListener(type, open);
    return () => { for (const type of events) zone.removeEventListener(type, open); };
  }, [zoneRef]);

  return { collapsed: collapsed && enabled };
}
