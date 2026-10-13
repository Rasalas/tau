import { useEffect, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useClientEnvironment } from "../../client-environment";
import { useWorkspaceFileHistory } from "../../touch/use-workspace-file-history";
import { useEscapeLayer } from "./escape-layers";
import { focusableElements, openedByKeyboard, useFocusReturn, useFocusTrap } from "./focus";
import { placeFloating, pointRect, viewportSize, type FloatingAlign, type FloatingSide } from "./floating";

/**
 * A modal over a scrim, centred in the window: Tab stays inside it, Escape and a click on the scrim
 * close it, and focus goes back to whatever had it when it opened. The first
 * field that asks for `autoFocus` gets focus, else the first control.
 */
export function Dialog({ label, className, onClose, children, historyManaged = false }: {
  label: string;
  /** A composite dialog may coordinate its own close buttons through the same hook. */
  historyManaged?: boolean;
  className?: string;
  onClose(): void;
  children: ReactNode;
}) {
  const { profile } = useClientEnvironment();
  const close = useWorkspaceFileHistory(label, onClose, profile === "compact" && !historyManaged);
  const surface = useRef<HTMLElement>(null);
  useFocusReturn(true, surface);
  useFocusTrap(surface);
  useEscapeLayer(close);
  useLayoutEffect(() => {
    const element = surface.current;
    if (!element || element.contains(document.activeElement)) return;
    (focusableElements(element)[0] ?? element).focus({ preventScroll: true });
  }, []);
  return (
    <div className="palette-backdrop dialog-backdrop" onMouseDown={close}>
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
 * outside it or Escape closes it, and focus goes back where it was. Opened
 * from the keyboard it takes focus on its first control; opened by a press it
 * takes it on itself, so Tab and a screen reader continue inside it. A hover
 * card that only previews turns that off with `takeFocus={false}`.
 */
export function Popover({ anchor, side = "bottom", align = "start", label, className, dismissOnFocusOutside = false, takeFocus = true, onClose, children }: {
  anchor: RefObject<HTMLElement | null> | { x: number; y: number };
  side?: FloatingSide;
  align?: FloatingAlign;
  label?: string;
  className?: string;
  /** Close when focus moves to another control, in addition to outside presses. */
  dismissOnFocusOutside?: boolean;
  /** Move focus into the card when it opens (API 1.61.0). Off for a card that opens on hover and leaves focus where it is. */
  takeFocus?: boolean;
  onClose(): void;
  children: ReactNode;
}) {
  const { profile } = useClientEnvironment();
  const dismiss = useWorkspaceFileHistory(label ?? "popover", onClose, profile === "compact");
  const surface = useRef<HTMLDivElement>(null);
  const close = useRef(dismiss);
  close.current = dismiss;
  useFocusReturn(true, surface);
  const isTopLayer = useEscapeLayer(dismiss);

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

  // After the placement above, so the card is where it belongs when it takes focus.
  useLayoutEffect(() => {
    const element = surface.current;
    if (!takeFocus || !element || element.contains(document.activeElement)) return;
    const first = openedByKeyboard() ? focusableElements(element)[0] : undefined;
    (first ?? element).focus({ preventScroll: true });
    // Only when it opens.
  }, []);

  useEffect(() => {
    const onOutside = (event: Event) => {
      if (!isTopLayer(event)) return;
      const target = event.target as Node;
      if (surface.current?.contains(target)) return;
      if ("current" in anchor && anchor.current?.contains(target)) return;
      close.current();
    };
    document.addEventListener("pointerdown", onOutside, true);
    if (dismissOnFocusOutside) document.addEventListener("focusin", onOutside, true);
    return () => {
      document.removeEventListener("pointerdown", onOutside, true);
      document.removeEventListener("focusin", onOutside, true);
    };
  }, [anchor, isTopLayer, dismissOnFocusOutside]);

  return createPortal(
    <div ref={surface} className={`popover${className ? ` ${className}` : ""}`} role="dialog" aria-label={label} tabIndex={-1}>
      {children}
    </div>,
    document.body,
  );
}
