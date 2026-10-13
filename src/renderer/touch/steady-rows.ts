import { useEffect, useLayoutEffect, useState, type MouseEvent } from "react";

/** How long a list keeps its order after the last touch or scroll on it. */
export const ORDER_HOLD_MS = 2_000;
/** A press this soon after its row moved was aimed at the row that was there before. */
export const MOVED_PRESS_MS = 600;

const ROW = "[data-steady-row]";

/** Where each row was last drawn, and when one last moved or appeared. */
export class RowPlaces {
  private tops = new Map<string, number>();
  private moved = new Map<string, number>();

  /** `mark` false only catches up: a shift nobody saw happen has no time to hold against a press. */
  measure(rows: Iterable<{ id: string; top: number }>, now: number, mark = true): void {
    // The first rows a list draws were never anywhere else.
    const first = this.tops.size === 0;
    const tops = new Map<string, number>();
    for (const { id, top } of rows) {
      const before = this.tops.get(id);
      const moved = before === undefined ? !first : Math.abs(before - top) >= 1;
      if (mark && moved) this.moved.set(id, now);
      tops.set(id, top);
    }
    for (const id of this.moved.keys()) if (!tops.has(id)) this.moved.delete(id);
    this.tops = tops;
  }

  movedSince(id: string, at: number): boolean {
    const moved = this.moved.get(id);
    return moved !== undefined && moved > at - MOVED_PRESS_MS;
  }
}

export interface SteadyRows {
  /** The rows' ids as drawn when the hold began; set while the list holds its order. */
  held: readonly string[] | undefined;
  /** The ref for the list's scroller, which holds every row (`data-steady-row`). */
  scroller(element: HTMLDivElement | null): void;
  handlers: SteadyRowsController["handlers"];
}

function rowOf(target: EventTarget | null): string | undefined {
  return target instanceof Element ? target.closest<HTMLElement>(ROW)?.dataset.steadyRow : undefined;
}

/** One list's hold and press guard; the hook hands React its ref and handlers. */
class SteadyRowsController {
  private readonly places = new RowPlaces();
  private element: HTMLDivElement | null = null;
  private observer: ResizeObserver | undefined;
  private holding = false;
  private pressing = false;
  private press: { id: string | undefined; at: number } | undefined;
  private until = 0;
  private timer: number | undefined;

  constructor(private readonly setHeld: (held: readonly string[] | undefined) => void) {}

  /** What grows above the list without rendering it (a kit's notice strip, say) shrinks the scroller and moves its rows. */
  readonly attach = (element: HTMLDivElement | null): void => {
    this.observer?.disconnect();
    this.observer = undefined;
    this.element = element;
    if (!element || typeof ResizeObserver === "undefined") return;
    this.observer = new ResizeObserver(() => this.measure(true));
    this.observer.observe(element);
  };

  connect(): () => void {
    window.addEventListener("pointerup", this.lifted, true);
    window.addEventListener("pointercancel", this.lifted, true);
    return () => {
      window.removeEventListener("pointerup", this.lifted, true);
      window.removeEventListener("pointercancel", this.lifted, true);
      window.clearTimeout(this.timer);
    };
  }

  measure(mark: boolean): void {
    const element = this.element;
    if (!element) return;
    // Counted from the scroller's own top on screen: a scroll moves no row, a notice above it moves them all.
    const offset = element.scrollTop;
    this.places.measure(this.drawn().map((row) => ({ id: row.dataset.steadyRow!, top: row.getBoundingClientRect().top + offset })), performance.now(), mark);
  }

  readonly handlers = {
    onPointerDownCapture: (event: { target: EventTarget }): void => {
      // A shift no render or resize reported (a header that moved, say) is old news by now.
      this.measure(false);
      this.pressing = true;
      this.press = { id: rowOf(event.target), at: performance.now() };
      this.hold();
    },
    onScrollCapture: (): void => this.hold(),
    onClickCapture: (event: MouseEvent): void => {
      const id = rowOf(event.target);
      // A keyboard's click (no detail) aims at the focused row, not at a place.
      if (!id || event.detail === 0) return;
      const press = this.press;
      if (press && press.id === id && !this.places.movedSince(id, press.at)) return;
      event.preventDefault();
      event.stopPropagation();
    },
  };

  private drawn(): HTMLElement[] {
    return [...this.element?.querySelectorAll<HTMLElement>(ROW) ?? []];
  }

  private hold(): void {
    this.until = performance.now() + ORDER_HOLD_MS;
    if (!this.holding) {
      this.holding = true;
      this.setHeld(this.drawn().map((row) => row.dataset.steadyRow!));
    }
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(this.release, ORDER_HOLD_MS);
  }

  private readonly release = (): void => {
    window.clearTimeout(this.timer);
    // A finger still down holds on; its lift starts the wait again.
    if (this.pressing) return;
    const wait = this.until - performance.now();
    if (wait > 0) { this.timer = window.setTimeout(this.release, wait); return; }
    this.holding = false;
    this.setHeld(undefined);
  };

  private readonly lifted = (): void => {
    if (!this.pressing) return;
    this.pressing = false;
    this.hold();
  };
}

/**
 * A row list that never opens a row other than the one the finger aimed at:
 * its order holds while it is touched or scrolled, and a tap on a row that
 * moved just before is dropped.
 */
export function useSteadyRows(): SteadyRows {
  const [held, setHeld] = useState<readonly string[]>();
  const [rows] = useState(() => new SteadyRowsController(setHeld));
  // A render of the list is when its rows move: a new order, a row in or out, a notice above them.
  useLayoutEffect(() => rows.measure(true));
  useEffect(() => rows.connect(), [rows]);
  return { held, scroller: rows.attach, handlers: rows.handlers };
}
