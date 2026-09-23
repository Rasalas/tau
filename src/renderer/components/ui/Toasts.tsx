import { useEffect, useReducer, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { Check, CircleAlert, CircleCheck, Copy, Info, TriangleAlert, X } from "lucide-react";
import type { Toast, ToastStore, ToastType } from "../../../workbench/toast-store";
import { usePlatform } from "../../platform-context";
import { useKeepClear } from "../../reserved-region";
import { tooltipProps } from "./Tooltip";
import { Spinner } from "./Feedback";
import "./toasts.css";

/** How far each toast behind the front one shows below it while the stack is collapsed. */
const PEEK = 8;
const GAP = 8;
const SHRINK = 0.05;
/** The frame's top and bottom border, around the card that is measured. */
const FRAME = 2;

const ICONS: Record<ToastType, ReactNode> = {
  info: <Info size={15} />,
  success: <CircleCheck size={15} />,
  warning: <TriangleAlert size={15} />,
  error: <CircleAlert size={15} />,
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
      </div>
      {toast.copyText ? <CopyButton text={toast.copyText} /> : null}
      <button type="button" className="toast-icon-button" aria-label="Dismiss notification" onClick={() => store.dismiss(toast.id)}>
        <X size={13} />
      </button>
    </>
  );
}

/**
 * The toast stack in the window's top-right corner, after T3 Code's: the
 * newest in front, up to `maxVisible` peeking behind it, all of them laid out
 * apart while the pointer or focus is on the stack. F6 moves focus into it.
 */
export function ToastViewport({ store }: { store: ToastStore }) {
  const toasts = useSyncExternalStore(store.subscribe, store.getToasts);
  const visible = toasts.slice(0, store.maxVisible);
  const [expanded, setExpanded] = useState(false);
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

  // With the last toast gone nothing is under the pointer or holds focus any more.
  useEffect(() => {
    if (visible.length > 0) return;
    setExpanded(false);
    store.release("hover");
    store.release("focus");
  }, [store, visible.length]);

  const front = heights.current.get(visible[0]?.id ?? "") ?? 0;
  let offset = 0;
  const layout = visible.map((toast, index) => {
    const height = heights.current.get(toast.id) ?? front;
    const scale = expanded ? 1 : 1 - index * SHRINK;
    const y = expanded ? offset : index * PEEK + (1 - scale) * front;
    offset += height + GAP;
    return { toast, index, style: { zIndex: visible.length - index, transform: `translateY(${y}px) scale(${scale})`, ...(!expanded && index > 0 && front ? { height: front } : {}) } as CSSProperties };
  });
  const stackHeight = expanded ? Math.max(0, offset - GAP) : front + Math.max(0, visible.length - 1) * PEEK;

  return (
    <section
      ref={stack}
      className="toast-stack"
      aria-label="Notifications"
      data-expanded={expanded || undefined}
      style={{ height: stackHeight }}
      onPointerEnter={() => { setExpanded(true); store.hold("hover"); }}
      onPointerLeave={() => { setExpanded(false); store.release("hover"); }}
      onFocus={() => { setExpanded(true); store.hold("focus"); }}
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setExpanded(false);
        store.release("focus");
      }}
    >
      {layout.map(({ toast, index, style }) => (
        <div
          key={toast.id}
          className="toast-item"
          data-type={toast.type}
          data-behind={index > 0 && !expanded ? "" : undefined}
          role={toast.type === "error" ? "alert" : "status"}
          tabIndex={-1}
          style={style}
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
