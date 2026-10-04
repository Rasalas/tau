import { useEffect, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useEscapeLayer } from "./escape-layers";
import { focusableElements, useFocusReturn, useFocusTrap } from "./focus";
import { placeFloating, pointRect, viewportSize, type FloatingAlign, type FloatingSide } from "./floating";

/**
 * A modal over a scrim, centred in the window: Tab stays inside it, Escape and a click on the scrim
 * close it, and focus goes back to whatever had it when it opened. The first
 * field that asks for `autoFocus` gets focus, else the first control.
 */
export function Dialog({ label, className, onClose, children }: {
  label: string;
  className?: string;
  onClose(): void;
  children: ReactNode;
}) {
  const surface = useRef<HTMLElement>(null);
  useFocusReturn(true, surface);
  useFocusTrap(surface);
  useEscapeLayer(onClose);
  useLayoutEffect(() => {
    const element = surface.current;
    if (!element || element.contains(document.activeElement)) return;
    (focusableElements(element)[0] ?? element).focus({ preventScroll: true });
  }, []);
  return (
    <div className="palette-backdrop dialog-backdrop" onMouseDown={onClose}>
      <section
        ref={surface}
        className={className}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >{children}</section>
    </div>
  );
}

/**
 * A card beside an element or a point, kept inside the window: it flips to
 * the other side when this one has no room and slides along the edge. A press
 * outside it or Escape closes it, and focus goes back where it was.
 */
export function Popover({ anchor, side = "bottom", align = "start", label, className, onClose, children }: {
  anchor: RefObject<HTMLElement | null> | { x: number; y: number };
  side?: FloatingSide;
  align?: FloatingAlign;
  label?: string;
  className?: string;
  onClose(): void;
  children: ReactNode;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useFocusReturn(true, surface);
  const isTopLayer = useEscapeLayer(onClose);

  useLayoutEffect(() => {
    const element = surface.current;
    if (!element) return undefined;
    const place = () => {
      const rect = "current" in anchor ? anchor.current?.getBoundingClientRect() : pointRect(anchor.x, anchor.y);
      if (!rect) return;
      const placed = placeFloating(rect, element.getBoundingClientRect(), viewportSize(), { side, align });
      element.style.left = `${placed.left}px`;
      element.style.top = `${placed.top}px`;
      element.dataset.side = placed.side;
    };
    place();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(place);
    observer?.observe(element);
    if ("current" in anchor && anchor.current) observer?.observe(anchor.current);
    window.addEventListener("resize", place);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [align, anchor, side]);

  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      if (!isTopLayer(event)) return;
      const target = event.target as Node;
      if (surface.current?.contains(target)) return;
      if ("current" in anchor && anchor.current?.contains(target)) return;
      close.current();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [anchor, isTopLayer]);

  return createPortal(
    <div ref={surface} className={`popover${className ? ` ${className}` : ""}`} role="dialog" aria-label={label} tabIndex={-1}>
      {children}
    </div>,
    document.body,
  );
}
