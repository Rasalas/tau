import { useEffect, useState, type RefObject } from "react";
import { LONG_PRESS_MS, SWIPE_SLOP_PX } from "./swipe-gesture";

/** A resting touch opens the message's menu; scrolling and interactive content keep their gestures. */
export function useMessageMenu(actions: RefObject<HTMLElement | null>) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const shell = actions.current?.closest<HTMLElement>(".message-shell");
    if (!shell) return undefined;
    let press: { id: number; x: number; y: number; timer: ReturnType<typeof setTimeout> } | undefined;
    let consumedUntil = 0;
    const cancel = () => { if (press) clearTimeout(press.timer); press = undefined; };
    const eligible = (target: EventTarget | null) => document.body.dataset.profile === "compact" && target instanceof Element && !target.closest("button, a, input, textarea, summary, [role=button], [contenteditable=true]");
    const show = () => { cancel(); consumedUntil = performance.now() + 1500; setOpen(true); };
    const down = (event: PointerEvent) => {
      cancel();
      if (event.pointerType !== "touch" || !eligible(event.target)) return;
      press = { id: event.pointerId, x: event.clientX, y: event.clientY, timer: setTimeout(show, LONG_PRESS_MS) };
    };
    const move = (event: PointerEvent) => {
      if (press && event.pointerId === press.id && Math.hypot(event.clientX - press.x, event.clientY - press.y) > SWIPE_SLOP_PX) cancel();
    };
    const context = (event: MouseEvent) => { if (eligible(event.target)) { event.preventDefault(); show(); } };
    const click = (event: MouseEvent) => {
      if (performance.now() < consumedUntil) { consumedUntil = 0; event.preventDefault(); event.stopPropagation(); }
    };
    const end = (event: TouchEvent) => { if (performance.now() < consumedUntil && event.cancelable) event.preventDefault(); };
    shell.addEventListener("pointerdown", down);
    shell.addEventListener("contextmenu", context);
    shell.addEventListener("click", click, true);
    shell.addEventListener("touchend", end, { passive: false });
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", cancel);
    document.addEventListener("pointercancel", cancel);
    return () => {
      cancel();
      shell.removeEventListener("pointerdown", down);
      shell.removeEventListener("contextmenu", context);
      shell.removeEventListener("click", click, true);
      shell.removeEventListener("touchend", end);
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", cancel);
      document.removeEventListener("pointercancel", cancel);
    };
  }, [actions]);
  return { open, close: () => setOpen(false) };
}
