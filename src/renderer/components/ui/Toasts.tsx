import { useEffect, useLayoutEffect, useReducer, useRef, useState, useSyncExternalStore, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Check, CircleAlert, CircleCheck, Copy, Info, TriangleAlert, X } from "lucide-react";
import type { Toast, ToastStore, ToastType } from "../../../workbench/toast-store";
import { usePlatform } from "../../platform-context";
import { useKeepClear } from "../../reserved-region";
import { swipeAxis, type SwipeAxis } from "../../touch/swipe-gesture";
import { tooltipProps } from "./Tooltip";
import { Spinner } from "./Feedback";
import "./toasts.css";

/** How far each toast behind the front one shows below it while the stack is collapsed. */
const PEEK = 8;
const GAP = 8;
const SHRINK = 0.05;
/** The frame's top and bottom border, around the card that is measured. */
const FRAME = 2;
/** A sideways swipe this far across the toast, or this fast (px/ms), dismisses it. */
const SWIPE_DISMISS_SHARE = 0.35;
const SWIPE_DISMISS_VELOCITY = 0.5;
const SWIPE_DISMISS_MIN_PX = 24;

/** Whether letting go of a toast dragged `dx` px across `width` at `velocity` px/ms dismisses it. */
export function toastSwipeDismisses(dx: number, width: number, velocity: number): boolean {
  const distance = Math.abs(dx);
  const sameWay = Math.sign(velocity) === Math.sign(dx);
  return distance >= width * SWIPE_DISMISS_SHARE || (distance >= SWIPE_DISMISS_MIN_PX && sameWay && Math.abs(velocity) >= SWIPE_DISMISS_VELOCITY);
}

export type ToastPlacement = "top" | "bottom";

interface Placed { toast: Toast; index: number; style: CSSProperties }

/**
 * Where each visible toast sits in the stack, and how tall the stack is. From
 * the top, the newest is first and the others peek under it; from the bottom,
 * the newest is last, nearest the thumb, and the others peek above it.
 */
export function layoutToasts(visible: readonly Toast[], heights: ReadonlyMap<string, number>, expanded: boolean, placement: ToastPlacement): { items: Placed[]; height: number } {
  const front = heights.get(visible[0]?.id ?? "") ?? 0;
  const sizes = visible.map((toast) => heights.get(toast.id) ?? front);
  const height = expanded
    ? Math.max(0, sizes.reduce((sum, size) => sum + size + GAP, 0) - GAP)
    : front + Math.max(0, visible.length - 1) * PEEK;
  let offset = 0;
  const items = visible.map((toast, index) => {
    const size = sizes[index]!;
    const scale = expanded ? 1 : 1 - index * SHRINK;
    let y: number;
    if (placement === "top") y = expanded ? offset : index * PEEK + (1 - scale) * front;
    else y = expanded ? height - offset - size : height - front - index * PEEK - (1 - scale) * front;
    offset += size + GAP;
    const style: CSSProperties = {
      zIndex: visible.length - index,
      transform: `translateX(var(--toast-swipe-x, 0px)) translateY(${y}px) scale(${scale})`,
      ...(!expanded && index > 0 && front ? { height: front } : {}),
    };
    return { toast, index, style };
  });
  return { items, height };
}

const ICONS: Record<ToastType, ReactNode> = {
  info: <Info size={14} />,
  success: <CircleCheck size={14} />,
  warning: <TriangleAlert size={14} />,
  error: <CircleAlert size={14} />,
  loading: <Spinner size="sm" />,
};

function CopyButton({ text }: { text: string }) {
  const platform = usePlatform();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1400);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const label = copied ? "Copied" : "Copy";
  return (
    <button
      type="button"
      className={`toast-icon-button${copied ? " copied" : ""}`}
      aria-label={label}
      {...tooltipProps(label)}
      // A clipboard the client refuses is not worth a second toast; the text is still there to select.
      onClick={() => { void platform.clipboard.writeText(text).then(() => setCopied(true), () => undefined); }}
    >{copied ? <Check size={13} /> : <Copy size={13} />}</button>
  );
}

function ToastCard({ toast, store }: { toast: Toast; store: ToastStore }) {
  return (
    <>
      <span className="toast-type" aria-hidden="true">{ICONS[toast.type]}</span>
      <div className="toast-body">
        {toast.title ? <strong>{toast.title}</strong> : null}
        {toast.description ? <p>{toast.description}</p> : null}
      </div>
      {toast.actions?.length ? (
        <div className="toast-actions">
          {toast.actions.map((action) => (
            <button
              key={action.label}
              type="button"
              onClick={() => { action.run(); if (!action.keepOpen) store.dismiss(toast.id); }}
            >{action.label}</button>
          ))}
        </div>
      ) : null}
      {toast.copyText ? <CopyButton text={toast.copyText} /> : null}
      <button type="button" className="toast-icon-button" aria-label="Dismiss notification" onClick={() => store.dismiss(toast.id)}>
        <X size={13} />
      </button>
    </>
  );
}

/**
 * The toast stack in the window's top-right corner: the
 * newest in front, up to `maxVisible` peeking behind it, all of them laid out
 * apart while the pointer or focus is on the stack. F6 moves focus into it.
 *
 * On a touch layout (`placement: "bottom"`) the stack sits above the docked
 * composer, under every sheet and dialog, so it never takes a tap meant for
 * one; a toast a sheet covers keeps its time, and a sideways swipe dismisses.
 */
export function ToastViewport({ store, placement = "top" }: { store: ToastStore; placement?: ToastPlacement }) {
  const toasts = useSyncExternalStore(store.subscribe, store.getToasts);
  const visible = toasts.slice(0, store.maxVisible);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const expanded = hovered || focused;
  const stack = useRef<HTMLElement>(null);
  const heights = useRef(new Map<string, number>());
  const [, remeasured] = useReducer((count: number) => count + 1, 0);
  const [observer] = useState(() => typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver((entries) => {
    let changed = false;
    for (const entry of entries) {
      const element = entry.target as HTMLElement;
      const height = element.offsetHeight + FRAME;
      if (heights.current.get(element.dataset.toastId ?? "") !== height) {
        heights.current.set(element.dataset.toastId ?? "", height);
        changed = true;
      }
    }
    if (changed) remeasured();
  }));
  useEffect(() => () => observer?.disconnect(), [observer]);
  useKeepClear(stack, visible.length > 0);
  const bottom = placement === "bottom";
  const floor = useComposerFloor(bottom && visible.length > 0);
  useEffect(() => bottom ? store.deferExpiry((id) => isCovered(stack.current, id)) : undefined, [bottom, store]);
  const swipe = useToastSwipe(store);

  useEffect(() => {
    const onVisibility = () => document.visibilityState === "hidden" ? store.hold("hidden") : store.release("hidden");
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "F6" || !stack.current?.firstElementChild) return;
      event.preventDefault();
      (stack.current.firstElementChild as HTMLElement).focus();
    };
    document.addEventListener("visibilitychange", onVisibility);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [store]);

  // A toast taken away from under the pointer or from focus sends neither
  // pointerleave nor blur, so both are checked rather than waited for.
  useEffect(() => {
    if (!hovered) return undefined;
    const onMove = (event: PointerEvent) => {
      if (stack.current?.contains(event.target as Node)) return;
      setHovered(false);
    };
    document.addEventListener("pointermove", onMove, true);
    return () => document.removeEventListener("pointermove", onMove, true);
  }, [hovered]);
  useEffect(() => {
    if (focused && !stack.current?.contains(document.activeElement)) setFocused(false);
  }, [focused, toasts]);
  useEffect(() => {
    if (hovered) store.hold("hover"); else store.release("hover");
  }, [hovered, store]);
  useEffect(() => {
    if (focused) store.hold("focus"); else store.release("focus");
  }, [focused, store]);
  useEffect(() => {
    if (visible.length > 0) return;
    setHovered(false);
    setFocused(false);
  }, [visible.length]);

  const { items: layout, height: stackHeight } = layoutToasts(visible, heights.current, expanded, placement);

  return (
    <section
      ref={stack}
      className="toast-stack"
      aria-label="Notifications"
      data-expanded={expanded || undefined}
      data-placement={placement}
      style={{ height: stackHeight, ...(bottom && floor !== undefined ? { bottom: floor } : {}) }}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false); }}
    >
      {layout.map(({ toast, index, style }) => (
        <div
          key={toast.id}
          className="toast-item"
          data-type={toast.type}
          data-toast-id={toast.id}
          data-behind={index > 0 && !expanded ? "" : undefined}
          role={toast.type === "error" ? "alert" : "status"}
          tabIndex={-1}
          style={style}
          {...(bottom ? swipe(toast.id) : {})}
        >
          {/* Measured, not the frame: a toast behind the front one is clipped to the front's height. */}
          <div
            className="toast-card"
            data-toast-id={toast.id}
            ref={(element) => {
              if (!element || !observer) return undefined;
              observer.observe(element);
              return () => { observer.unobserve(element); heights.current.delete(toast.id); };
            }}
          >
            <ToastCard toast={toast} store={store} />
          </div>
        </div>
      ))}
    </section>
  );
}

/**
 * How far above the bottom edge the stack keeps: over the composer while it is
 * docked there, else `undefined` and the stylesheet's keyboard and safe-area
 * inset apply.
 */
function useComposerFloor(active: boolean): number | undefined {
  const [floor, setFloor] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    if (!active) { setFloor(undefined); return undefined; }
    const composer = document.querySelector<HTMLElement>(".conversation-composer-host");
    const measure = () => {
      const rect = composer?.isConnected && composer.classList.contains("docked") ? composer.getBoundingClientRect() : undefined;
      setFloor(rect && rect.height > 0 ? Math.max(0, Math.round(window.innerHeight - rect.top)) + GAP : undefined);
    };
    measure();
    const resized = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    const moved = typeof MutationObserver === "undefined" ? undefined : new MutationObserver(measure);
    if (composer) {
      resized?.observe(composer);
      // `style`: the move between start and docked is a transform, measured again once it is cleared.
      moved?.observe(composer, { attributes: true, attributeFilter: ["class", "style"] });
    }
    const viewport = window.visualViewport;
    window.addEventListener("resize", measure);
    viewport?.addEventListener("resize", measure);
    viewport?.addEventListener("scroll", measure);
    return () => {
      resized?.disconnect();
      moved?.disconnect();
      window.removeEventListener("resize", measure);
      viewport?.removeEventListener("resize", measure);
      viewport?.removeEventListener("scroll", measure);
    };
  }, [active]);
  return floor;
}

/** Whether something is drawn over the toast's middle: a sheet, a dialog, Settings. */
function isCovered(stack: HTMLElement | null, id: string): boolean {
  const item = [...stack?.querySelectorAll<HTMLElement>(".toast-item") ?? []].find((element) => element.dataset.toastId === id);
  if (!item || typeof document.elementFromPoint !== "function") return false;
  const rect = item.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + Math.min(rect.height / 2, 20));
  return hit !== null && !item.contains(hit);
}

/** A finger drags a toast sideways; far or fast enough, it slides out and goes. */
function useToastSwipe(store: ToastStore): (id: string) => {
  onPointerDown(event: ReactPointerEvent<HTMLElement>): void;
  onPointerMove(event: ReactPointerEvent<HTMLElement>): void;
  onPointerUp(event: ReactPointerEvent<HTMLElement>): void;
  onPointerCancel(event: ReactPointerEvent<HTMLElement>): void;
  onClickCapture(event: ReactMouseEvent<HTMLElement>): void;
} {
  const drag = useRef<{ id: string; pointer: number; startX: number; startY: number; lastX: number; lastT: number; velocity: number; axis: SwipeAxis } | undefined>(undefined);
  const swiped = useRef(false);
  const place = (element: HTMLElement, dx: number, animate: boolean) => {
    element.style.transition = animate ? "" : "none";
    element.style.setProperty("--toast-swipe-x", `${dx}px`);
    element.style.opacity = dx === 0 ? "" : String(Math.max(0.2, 1 - Math.abs(dx) / Math.max(1, element.offsetWidth)));
  };
  const release = (element: HTMLElement, dismiss: boolean) => {
    const current = drag.current;
    drag.current = undefined;
    store.release("swipe");
    if (!current || current.axis !== "horizontal") return;
    const dx = current.lastX - current.startX;
    if (!dismiss || !toastSwipeDismisses(dx, element.offsetWidth, current.velocity)) { place(element, 0, true); return; }
    const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) { store.dismiss(current.id); return; }
    element.style.transition = "transform 160ms ease, opacity 160ms ease";
    element.style.setProperty("--toast-swipe-x", `${Math.sign(dx) * (element.offsetWidth + 24)}px`);
    element.style.opacity = "0";
    window.setTimeout(() => store.dismiss(current.id), 160);
  };
  return (id) => ({
    onPointerDown: (event) => {
      if (event.pointerType !== "touch" || !event.isPrimary) return;
      swiped.current = false;
      drag.current = { id, pointer: event.pointerId, startX: event.clientX, startY: event.clientY, lastX: event.clientX, lastT: event.timeStamp, velocity: 0, axis: "pending" };
      store.hold("swipe");
    },
    onPointerMove: (event) => {
      const current = drag.current;
      if (!current || current.pointer !== event.pointerId) return;
      if (current.axis === "pending") current.axis = swipeAxis(event.clientX - current.startX, event.clientY - current.startY);
      if (current.axis !== "horizontal") return;
      swiped.current = true;
      const elapsed = Math.max(1, event.timeStamp - current.lastT);
      current.velocity = (event.clientX - current.lastX) / elapsed;
      current.lastX = event.clientX;
      current.lastT = event.timeStamp;
      place(event.currentTarget, current.lastX - current.startX, false);
    },
    onPointerUp: (event) => { if (drag.current?.pointer === event.pointerId) release(event.currentTarget, true); },
    onPointerCancel: (event) => { if (drag.current?.pointer === event.pointerId) release(event.currentTarget, false); },
    // A swipe that ended on a button is not a tap on it.
    onClickCapture: (event) => {
      if (!swiped.current) return;
      swiped.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
  });
}
