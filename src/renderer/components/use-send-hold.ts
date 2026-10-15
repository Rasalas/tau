import { useEffect, useRef, type MouseEvent, type PointerEvent, type TouchEvent } from "react";
import { LONG_PRESS_MS, SWIPE_SLOP_PX } from "../touch/swipe-gesture";

/**
 * A finger held on send opens the send menu. Nothing takes focus while it rests,
 * so the keyboard stays up until the menu opens; the release after is no tap.
 */
export function useSendHold(open: (() => void) | undefined) {
  const press = useRef<{ x: number; y: number; timer: ReturnType<typeof setTimeout> }>(undefined);
  // The menu is open from this press; its release still has to come.
  const opened = useRef(false);
  const openRef = useRef(open);
  openRef.current = open;
  const end = () => {
    if (press.current) clearTimeout(press.current.timer);
    press.current = undefined;
  };
  const fire = () => {
    end();
    opened.current = true;
    navigator.vibrate?.(8);
    openRef.current?.();
  };
  useEffect(() => end, []);
  return {
    /** Whether this click is the release of a hold, which already opened the menu. */
    consumed() {
      const held = opened.current;
      opened.current = false;
      return held;
    },
    props: open ? {
      onPointerDown(event: PointerEvent) {
        end();
        opened.current = false;
        if (event.pointerType !== "mouse") press.current = { x: event.clientX, y: event.clientY, timer: setTimeout(fire, LONG_PRESS_MS) };
      },
      onPointerMove(event: PointerEvent) {
        const at = press.current;
        if (at && Math.hypot(event.clientX - at.x, event.clientY - at.y) > SWIPE_SLOP_PX) end();
      },
      onPointerUp: end,
      onPointerCancel: end,
      // Android's own long press arrives as a context menu, and so does a right click.
      onContextMenu(event: MouseEvent) {
        event.preventDefault();
        if (!opened.current) fire();
      },
      // Without its mouse events the release cannot land on the menu's scrim and close it.
      onTouchEnd(event: TouchEvent) {
        if (!opened.current || !event.cancelable) return;
        event.preventDefault();
        opened.current = false;
      },
    } : {},
  };
}
