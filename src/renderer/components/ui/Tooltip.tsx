import { cloneElement, useEffect, useLayoutEffect, useRef, useState, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { openedByKeyboard } from "./focus";
import { placeFloating, viewportSize, type FloatingSide } from "./floating";

/** How long a pointer rests on a trigger before its tooltip shows; Base UI's default. */
export const TOOLTIP_DELAY_MS = 600;
/** A tooltip closed less than this long ago lets the next one open at once, so a row of icons reads like one. */
export const TOOLTIP_GROUP_MS = 400;

export interface TooltipOptions {
  side?: FloatingSide | undefined;
  /** A chord drawn beside the text, e.g. "⌘K". */
  shortcut?: string | undefined;
  /** `truncated`: only when the trigger's own text is cut off, for a title that may fit. */
  when?: "always" | "truncated" | undefined;
  /**
   * `code` sets the text in the monospace face and lets it break anywhere, for paths and commands;
   * `lines` keeps the text's line breaks, for a few lines of details.
   */
  variant?: "default" | "code" | "lines" | undefined;
}

/** The attributes the tooltip layer reads; spread them on any element. */
export function tooltipProps(content: string | undefined, options: TooltipOptions = {}): Record<string, string> {
  if (!content) return {};
  return {
    "data-tooltip": content,
    ...(options.side ? { "data-tooltip-side": options.side } : {}),
    ...(options.shortcut ? { "data-tooltip-shortcut": options.shortcut } : {}),
    ...(options.when === "truncated" ? { "data-tooltip-when": "truncated" } : {}),
    ...(options.variant && options.variant !== "default" ? { "data-tooltip-variant": options.variant } : {}),
  };
}

/** Puts a tooltip on its one child; the layer core mounts draws it. */
export function Tooltip({ content, children, ...options }: TooltipOptions & { content: string | undefined; children: ReactElement }) {
  return cloneElement(children, tooltipProps(content, options));
}

interface Shown {
  target: HTMLElement;
  text: string;
  shortcut?: string;
  side: FloatingSide;
  code: boolean;
  lines: boolean;
}

const TOOLTIP_ID = "tau-tooltip";
const LINES = { whiteSpace: "pre-line" } as const;

function read(target: HTMLElement): Shown | undefined {
  const text = target.dataset.tooltip;
  if (!text) return undefined;
  if (target.dataset.tooltipWhen === "truncated" && target.scrollWidth <= target.clientWidth + 1) return undefined;
  const side = target.dataset.tooltipSide as FloatingSide | undefined;
  return {
    target,
    text,
    ...(target.dataset.tooltipShortcut ? { shortcut: target.dataset.tooltipShortcut } : {}),
    side: side ?? "top",
    code: target.dataset.tooltipVariant === "code",
    lines: target.dataset.tooltipVariant === "lines",
  };
}

const triggerOf = (node: EventTarget | null): HTMLElement | undefined =>
  node instanceof Element ? node.closest<HTMLElement>("[data-tooltip]") ?? undefined : undefined;

/**
 * The one tooltip of the window, for every element that carries
 * `data-tooltip`. It follows the pointer and keyboard focus through listeners
 * on the document, so a list of a thousand rows costs no component per row.
 * Opens after a rest, at once while another one was just open, on keyboard
 * focus without a wait, and closes on Escape, a press, a scroll or leaving.
 */
export function TooltipLayer() {
  const [shown, setShown] = useState<Shown>();
  const shownRef = useRef<Shown | undefined>(undefined);
  const popup = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let timer: number | undefined;
    let closedAt = -Infinity;
    // A trigger that was pressed stays quiet until the pointer leaves it.
    let pressed: HTMLElement | undefined;
    const set = (next: Shown | undefined) => {
      const previous = shownRef.current;
      if (previous && previous.target !== next?.target) {
        if (previous.target.getAttribute("aria-describedby") === TOOLTIP_ID) previous.target.removeAttribute("aria-describedby");
        closedAt = performance.now();
      }
      if (next && next.target.getAttribute("aria-label") !== next.text && !next.target.hasAttribute("aria-describedby")) {
        next.target.setAttribute("aria-describedby", TOOLTIP_ID);
      }
      shownRef.current = next;
      setShown(next);
    };
    const cancel = () => { window.clearTimeout(timer); timer = undefined; };
    const hide = () => { cancel(); if (shownRef.current) set(undefined); };
    const schedule = (target: HTMLElement, delay: number) => {
      cancel();
      const warm = shownRef.current !== undefined || performance.now() - closedAt < TOOLTIP_GROUP_MS;
      const open = () => { const next = read(target); if (next && target.isConnected) set(next); };
      if (warm || delay === 0) { open(); return; }
      timer = window.setTimeout(open, delay);
    };

    const onOver = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      const target = triggerOf(event.target);
      if (target === shownRef.current?.target || (target && target === pressed)) return;
      if (!target) { if (shownRef.current || timer) hide(); return; }
      if (shownRef.current) set(undefined);
      schedule(target, TOOLTIP_DELAY_MS);
    };
    const onOut = (event: PointerEvent) => {
      const target = triggerOf(event.target);
      if (!target || target.contains(event.relatedTarget as Node | null)) return;
      if (target === pressed) pressed = undefined;
      hide();
    };
    const onFocusIn = (event: FocusEvent) => {
      const target = triggerOf(event.target);
      if (!target || !openedByKeyboard()) return;
      schedule(target, 0);
    };
    const onDown = (event: Event) => { pressed = triggerOf(event.target); hide(); };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && shownRef.current) hide(); };
    // Only a scroll that moves the trigger; a transcript following its stream leaves the rail's tooltip alone.
    const onScroll = (event: Event) => {
      const target = shownRef.current?.target;
      if (target && (event.target === document || (event.target instanceof Node && event.target.contains(target)))) hide();
    };

    document.addEventListener("pointerover", onOver);
    document.addEventListener("pointerout", onOut);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", hide);
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("blur", hide);
    return () => {
      cancel();
      document.removeEventListener("pointerover", onOver);
      document.removeEventListener("pointerout", onOut);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", hide);
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("blur", hide);
    };
  }, []);

  useLayoutEffect(() => {
    const element = popup.current;
    if (!shown || !element) return;
    const size = element.getBoundingClientRect();
    const placed = placeFloating(shown.target.getBoundingClientRect(), size, viewportSize(), { side: shown.side, offset: 6 });
    element.style.left = `${placed.left}px`;
    element.style.top = `${placed.top}px`;
    element.dataset.side = placed.side;
  }, [shown]);

  if (!shown) return null;
  return createPortal(
    <div ref={popup} id={TOOLTIP_ID} role="tooltip" className={`tooltip${shown.code ? " code" : ""}`}>
      <span style={shown.lines ? LINES : undefined}>{shown.text}</span>
      {shown.shortcut ? <kbd>{shown.shortcut}</kbd> : null}
    </div>,
    document.body,
  );
}
