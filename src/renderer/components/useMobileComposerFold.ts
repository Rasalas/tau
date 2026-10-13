import { useEffect, useRef, type RefObject } from "react";

const FOLD_START_PX = 24;
const FOLD_END_PX = 120;
/** Allows the toolbar's 160 ms CSS transition to finish. */
const OPEN_DURATION_MS = 180;

/** Follows the reading gesture without rendering React on every scroll frame. */
export function useMobileComposerFold({ enabled, idle, zoneRef }: {
  enabled: boolean;
  idle(): boolean;
  zoneRef: RefObject<HTMLElement | null>;
}): void {
  const idleRef = useRef(idle);
  idleRef.current = idle;
  const openRef = useRef<(() => void) | undefined>(undefined);

  useEffect(() => {
    const zone = zoneRef.current;
    const conversation = zone?.closest(".conversation-column");
    const toolbar = zone?.querySelector<HTMLElement>(".composer-toolbar");
    if (!enabled || !zone || !conversation || !toolbar) return undefined;
    let reading: HTMLElement | undefined;
    let progress = 0;
    let frame: number | undefined;
    let openTimer: number | undefined;
    let pressing = false;
    const finishOpen = () => {
      openTimer = undefined;
      zone.classList.remove("folding");
      toolbar.inert = false;
    };
    const cancelFrame = () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      frame = undefined;
    };
    const draw = (next: number, follow: boolean) => {
      if (openTimer !== undefined) window.clearTimeout(openTimer);
      openTimer = undefined;
      zone.classList.toggle("fold-following", follow);
      zone.style.setProperty("--composer-fold", String(next));
      if (next > 0) {
        zone.classList.add("folding");
        // A partly clipped button is not a usable touch target or tab stop.
        toolbar.inert = true;
      } else if (progress > 0 && !follow
        && !(typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches)) {
        // Keep the transcript's end reservation while the toolbar opens.
        openTimer = window.setTimeout(finishOpen, OPEN_DURATION_MS);
      } else finishOpen();
      progress = next;
    };
    const open = () => { reading = undefined; cancelFrame(); if (progress > 0) draw(0, false); };
    openRef.current = () => { if (!pressing && progress > 0) open(); };
    const transcriptFor = (target: EventTarget | null) => {
      if (!(target instanceof Element)) return undefined;
      const scroller = target.closest<HTMLElement>(".transcript");
      return scroller?.closest(".conversation-column") === conversation ? scroller : undefined;
    };
    const onTouchStart = (event: TouchEvent) => { cancelFrame(); reading = transcriptFor(event.target); };
    const onWheel = (event: WheelEvent) => { if (!event.ctrlKey) { cancelFrame(); reading = transcriptFor(event.target); } };
    const onScroll = (event: Event) => {
      const scroller = transcriptFor(event.target);
      if (!scroller || event.target !== scroller) return;
      const distance = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
      if (reading !== scroller && distance > FOLD_START_PX) return;
      cancelFrame();
      frame = window.requestAnimationFrame(() => {
        frame = undefined;
        if (!idleRef.current()) { open(); return; }
        const distance = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
        draw(Math.max(0, Math.min(1, (distance - FOLD_START_PX) / (FOLD_END_PX - FOLD_START_PX))), true);
      });
    };
    const onPointerDown = () => { pressing = true; reading = undefined; cancelFrame(); };
    const onPointerEnd = () => { pressing = false; };
    const onFocus = () => { if (!pressing) open(); };
    // Keep the field in place until release, so a tap cannot land on a toolbar control.
    const onClick = () => { pressing = false; open(); };
    const onKey = () => { pressing = false; open(); };
    document.addEventListener("touchstart", onTouchStart, { capture: true, passive: true });
    document.addEventListener("wheel", onWheel, { capture: true, passive: true });
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    document.addEventListener("pointerup", onPointerEnd);
    document.addEventListener("pointercancel", onPointerEnd);
    zone.addEventListener("pointerdown", onPointerDown);
    zone.addEventListener("focusin", onFocus);
    zone.addEventListener("click", onClick);
    zone.addEventListener("keydown", onKey);
    return () => {
      openRef.current = undefined;
      cancelFrame();
      if (openTimer !== undefined) window.clearTimeout(openTimer);
      zone.style.removeProperty("--composer-fold");
      zone.classList.remove("folding", "fold-following");
      toolbar.inert = false;
      document.removeEventListener("touchstart", onTouchStart, true);
      document.removeEventListener("wheel", onWheel, true);
      document.removeEventListener("scroll", onScroll, true);
      document.removeEventListener("pointerup", onPointerEnd);
      document.removeEventListener("pointercancel", onPointerEnd);
      zone.removeEventListener("pointerdown", onPointerDown);
      zone.removeEventListener("focusin", onFocus);
      zone.removeEventListener("click", onClick);
      zone.removeEventListener("keydown", onKey);
    };
  }, [enabled, zoneRef]);

  // Drafts, attachments, open questions and the keyboard keep the controls visible.
  useEffect(() => { if (!idle()) openRef.current?.(); });
}
