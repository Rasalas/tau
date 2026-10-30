import { useEffect, useLayoutEffect, useReducer, useRef, useState, useSyncExternalStore, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import { Check, ChevronRight, CircleAlert, CircleCheck, CircleHelp, Copy, Info, TriangleAlert, X } from "lucide-react";
import { tapActionOf, type Toast, type ToastAction, type ToastStore, type ToastType } from "../../../workbench/toast-store";
import { usePlatform } from "../../platform-context";
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

interface Placed { toast: Toast; index: number; style: CSSProperties }

/**
 * Where each visible toast sits, from the stack's anchored edge: the newest
 * there, and the others peeking out past it or, expanded, laid out apart.
 */
export function layoutToasts(visible: readonly Toast[], heights: ReadonlyMap<string, number>, expanded: boolean, anchored: "top" | "bottom"): Placed[] {
  const front = heights.get(visible[0]?.id ?? "") ?? 0;
  const away = anchored === "top" ? 1 : -1;
  let offset = 0;
  return visible.map((toast, index) => {
    const scale = expanded ? 1 : 1 - index * SHRINK;
    // Held at the anchored edge, so the front toast stays put as the others fan out.
    const y = away * (expanded ? offset : index * PEEK + (1 - scale) * front) || 0;
    offset += (heights.get(toast.id) ?? front) + GAP;
    const style: CSSProperties = {
      zIndex: visible.length - index,
      transform: `translateX(var(--toast-swipe-x, 0px)) translateY(${y}px) scale(${scale})`,
      ...(!expanded && index > 0 && front ? { height: front } : {}),
    };
    return { toast, index, style };
  });
}

const ICONS: Record<ToastType, ReactNode> = {
  info: <Info size={14} />,
  success: <CircleCheck size={14} />,
  warning: <TriangleAlert size={14} />,
  error: <CircleAlert size={14} />,
  loading: <Spinner size="sm" />,
  question: <CircleHelp size={14} />,
};

function CopyButton({ text }: { text: string }) {
  const platform = usePlatform();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(timer);
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

function ToastCard({ toast, store, touch }: { toast: Toast; store: ToastStore; touch: boolean }) {
  // A failure is worth keeping: without its own copy text, Copy takes what the toast says.
  const copyText = toast.copyText ?? (toast.type === "error" ? [toast.title, toast.description].filter(Boolean).join(" · ") : "");
  const text = [toast.title, toast.description].filter(Boolean).join(" · ");
  const run = (action: ToastAction) => { action.run(); if (!action.keepOpen) store.dismiss(toast.id); };
  const tap = tapActionOf(toast);
  const icon = <span className="toast-type" aria-hidden="true">{ICONS[toast.type]}</span>;
  return (
    <>
      {tap ? (
        // The whole message is the button; Copy and Dismiss stay beside it, never inside.
        <button type="button" className="toast-open" aria-label={`${tap.label}: ${text}`} onClick={() => run(tap)}>
          {icon}
          <span className="toast-body">{text}</span>
          <span className="toast-chevron" aria-hidden="true" {...(touch ? {} : tooltipProps(tap.label))}><ChevronRight size={14} /></span>
        </button>
      ) : (
        <>
          {icon}
          {/* Buttons that would squeeze the text into a narrow column go under it. */}
          <div className="toast-main" data-stacked={(toast.actions?.length ?? 0) > 1 || (touch && !!toast.actions?.length) || undefined}>
            <p className="toast-body">{text}</p>
            {toast.actions?.length ? (
              <div className="toast-actions">
                {toast.actions.map((action) => (
                  <button key={action.label} type="button" onClick={() => run(action)}>{action.label}</button>
                ))}
              </div>
            ) : null}
          </div>
        </>
      )}
      {copyText ? <CopyButton text={copyText} /> : null}
      <button type="button" className="toast-icon-button" aria-label="Dismiss notification" onClick={() => store.dismiss(toast.id)}>
        <X size={13} />
      </button>
    </>
  );
}

/**
 * The toast stack under the conversation's header, or the stage's tab strip
 * or workspace card when the conversation is folded: the newest in front, up to
 * `maxVisible` peeking behind it, all of them laid out apart while the pointer
 * or focus is on the stack. F6 moves focus into it.
 *
 * On a touch layout the stack sits below the thread title, or beside the
 * overview's floating button, under every sheet and dialog, so it never takes
 * a tap meant for one; a toast a sheet
 * covers keeps its time, and a sideways swipe dismisses.
 */
export function ToastViewport({ store, touch = false }: { store: ToastStore; touch?: boolean }) {
  const toasts = useSyncExternalStore(store.subscribe, store.getToasts);
  const visible = toasts.slice(0, store.maxVisible);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const expanded = hovered || focused;
  const stack = useRef<HTMLElement>(null);
  const heights = useRef(new Map<string, number>());
  const [anchor, setAnchor] = useState<"top" | "bottom">("top");
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
  useStackPlace(stack, touch, visible.length, setAnchor);
  useEffect(() => touch ? store.deferExpiry((id) => isCovered(stack.current, id)) : undefined, [touch, store]);
  const swipe = useToastSwipe(store);

  useEffect(() => {
    const onVisibility = () => store[document.visibilityState === "hidden" ? "hold" : "release"]("hidden");
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
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
    store[hovered ? "hold" : "release"]("hover");
    store[focused ? "hold" : "release"]("focus");
  }, [hovered, focused, store]);
  useEffect(() => {
    if (visible.length > 0) return;
    setHovered(false);
    setFocused(false);
  }, [visible.length]);


  return (
    <section
      ref={stack}
      className="toast-stack"
      aria-label="Notifications"
      data-expanded={expanded || undefined}
      data-touch={touch || undefined}
      data-anchor={anchor}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false); }}
    >
      {layoutToasts(visible, heights.current, expanded, anchor).map(({ toast, index, style }) => (
        <div
          key={toast.id}
          className="toast-item"
          data-type={toast.type}
          data-toast-id={toast.id}
          data-behind={index > 0 && !expanded ? "" : undefined}
          role={toast.type === "error" ? "alert" : "status"}
          tabIndex={-1}
          style={style}
          {...(touch ? swipe(toast.id) : {})}
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
            <ToastCard toast={toast} store={store} touch={touch} />
          </div>
        </div>
      ))}
    </section>
  );
}

/**
 * Desktop: under the first anchor on screen. Touch: below the title and above
 * the composer, or beside the overview's floating button, opening upward.
 */
function useStackPlace(stack: RefObject<HTMLElement | null>, touch: boolean, count: number, setAnchor: (anchor: "top" | "bottom") => void): void {
  useLayoutEffect(() => {
    const style = stack.current?.style;
    if (!style || !count) return undefined;
    if (touch) return placeOnTouch(style, setAnchor);
    setAnchor("top");
    return placeUnderAnchor(style);
  }, [stack, touch, count, setAnchor]);
}

/**
 * What the desktop stack hangs under, the first one drawn wins. Each sits at
 * the top right of its side, so toasts keep one place as the layout changes.
 */
const ANCHORS = [
  { selector: ".workbench-center > .conversation-column > .thread-header", inset: 12 },
  { selector: ".workbench-center > .workspace-area > .stage > .stage-strip", inset: 12 },
  { selector: ".workbench-center > .workspace-area:not(.has-stage) > .region-workspace-summary", inset: 0 },
] as const;
/** Room kept at the window's bottom for one toast, however tall the anchor grows. */
const MIN_ROOM = 80;

function placeUnderAnchor(style: CSSStyleDeclaration): () => void {
  let anchor: { element: HTMLElement; inset: number } | undefined;
  const measure = () => {
    // Without an anchor (an overlay covers the workbench), the window's corner.
    const box = anchor?.element.getBoundingClientRect() ?? new DOMRect(0, 0, innerWidth, 0);
    const inset = anchor?.inset ?? 12;
    Object.assign(style, {
      top: `${Math.max(12, Math.min(box.bottom + 12, innerHeight - MIN_ROOM))}px`,
      bottom: "", left: "",
      right: `${innerWidth - box.right + inset}px`,
      width: `${Math.min(360, box.width - 2 * inset)}px`,
    });
    style.removeProperty("--toast-available-height");
  };
  const resized = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
  // The anchor changes as the stage and the workspace column open and close, both direct children here.
  const rearranged = new MutationObserver(() => find());
  const find = () => {
    resized?.disconnect();
    rearranged.disconnect();
    const center = document.querySelector<HTMLElement>(".workbench-center");
    for (const element of [center, center?.querySelector(":scope > .workspace-area")]) {
      if (element) rearranged.observe(element, { childList: true, attributes: true, attributeFilter: ["class"] });
    }
    anchor = undefined;
    for (const { selector, inset } of ANCHORS) {
      const element = document.querySelector<HTMLElement>(selector);
      if (element && element.getBoundingClientRect().width > 0) { anchor = { element, inset }; break; }
    }
    if (anchor) resized?.observe(anchor.element);
    measure();
  };
  find();
  window.addEventListener("resize", find);
  return () => {
    resized?.disconnect();
    rearranged.disconnect();
    window.removeEventListener("resize", find);
  };
}

const TOUCH_ANCHORS = ".touch-browser.screen.home, .touch-home-head, .touch-fab, .title-bar, .thread-header, .conversation-composer-host, .composer-surface";

function placeOnTouch(style: CSSStyleDeclaration, setAnchor: (anchor: "top" | "bottom") => void): () => void {
  let composer: HTMLElement | undefined;
  let surface: HTMLElement | undefined;
  let header: HTMLElement | undefined;
  let fab: HTMLElement | undefined;
  const visible = (selector: string, root: ParentNode = document) => [...root.querySelectorAll<HTMLElement>(selector)].find((element) => {
    const box = element.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  });
  const measure = () => {
    const viewport = window.visualViewport;
    const floor = viewport ? viewport.offsetTop + viewport.height : innerHeight;
    const head = header?.getBoundingClientRect();
    const top = head?.height ? head.bottom + GAP : undefined;
    const button = fab?.getBoundingClientRect();
    if (button?.height) {
      const bottom = Math.min(button.bottom, floor);
      Object.assign(style, { top: "auto", bottom: `${innerHeight - bottom}px`, left: "", right: `${innerWidth - button.left + GAP}px`, width: "" });
      style.setProperty("--toast-available-height", `${Math.max(0, bottom - (top ?? 0) - GAP)}px`);
      setAnchor("bottom");
      return;
    }
    setAnchor("top");
    Object.assign(style, { top: top === undefined ? "" : `${top}px`, bottom: "", left: "", right: "", width: "" });
    if (head?.width && visible(".touch-browser.sidebar")) {
      // A tablet's list has its own column; notifications belong to the chat.
      Object.assign(style, { left: `${head.left + 12}px`, right: `${innerWidth - head.right + 12}px` });
    }
    if (top !== undefined) {
      const dock = surface?.getBoundingClientRect();
      const limit = dock?.height ? Math.min(dock.top, floor) : floor;
      style.setProperty("--toast-available-height", `${Math.max(0, limit - top - GAP)}px`);
    } else style.removeProperty("--toast-available-height");
  };
  const resized = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
  const moved = new MutationObserver(measure);
  const find = () => {
    resized?.disconnect();
    moved.disconnect();
    const home = visible(".touch-browser.screen.home");
    fab = home ? visible(".touch-fab", home) : undefined;
    header = home ? visible(".touch-home-head", home) : visible(".title-bar, .thread-header");
    composer = home ? undefined : visible(".conversation-composer-host");
    surface = composer?.querySelector<HTMLElement>(".composer-surface") ?? composer;
    for (const element of [composer, surface, header, fab]) if (element) resized?.observe(element);
    // Docking changes the transform, without necessarily resizing the composer.
    if (composer) moved.observe(composer, { attributes: true, attributeFilter: ["class", "style"] });
    measure();
  };
  const rearranged = new MutationObserver((records) => {
    // Transcript updates are frequent. Only rediscover anchors when the layout changes.
    const relevant = (node: Node) => node instanceof Element && (node.matches(TOUCH_ANCHORS) || !!node.querySelector(TOUCH_ANCHORS));
    if (records.some((record) => record.type === "attributes"
      ? record.target instanceof Element && record.target.matches(`${TOUCH_ANCHORS}, .app-shell, .workbench-center`)
      : [...record.addedNodes, ...record.removedNodes].some(relevant))) find();
  });
  rearranged.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
  find();
  // The keyboard only moves the visual viewport.
  const viewport = window.visualViewport;
  viewport?.addEventListener("resize", measure);
  viewport?.addEventListener("scroll", measure);
  window.addEventListener("resize", find);
  return () => {
    resized?.disconnect();
    moved.disconnect();
    rearranged.disconnect();
    viewport?.removeEventListener("resize", measure);
    viewport?.removeEventListener("scroll", measure);
    window.removeEventListener("resize", find);
  };
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
