import { useLayoutEffect, useRef } from "react";

/** Set on the conversation column; the transcript's end spacer and its bottom insets read it. */
export const COMPOSER_RESERVE_PROPERTY = "--composer-reserve";
/** Actual dock coverage; unlike the end reservation, this shrinks when the composer folds. */
export const COMPOSER_DOCK_PROPERTY = "--composer-dock-height";

export interface ComposerReserveState {
  /** Room the transcript keeps at its end, in px. */
  reserve: number;
  /** The composer host's height when last seen unfolded. */
  unfoldedHost: number;
}

/**
 * The transcript runs on under the dock (controls row to composer), so its end
 * keeps the dock's height free. A folded composer is shorter, but the room stays
 * what the unfolded one needs: unfolding at the end then moves nothing.
 */
export function resolveComposerReserve(
  previous: ComposerReserveState,
  measured: { dock: number; host: number; folded: boolean },
): ComposerReserveState {
  const dock = Math.ceil(measured.dock);
  const host = Math.ceil(measured.host);
  if (!measured.folded) return { reserve: dock, unfoldedHost: host };
  return { reserve: dock + Math.max(0, previous.unfoldedHost - host), unfoldedHost: previous.unfoldedHost };
}

/** How much of the transcript's bottom the dock covers at most, in px; 0 outside a thread. */
export function composerReserve(node: Element | null | undefined): number {
  if (!node) return 0;
  const value = Number.parseFloat(window.getComputedStyle(node).getPropertyValue(COMPOSER_RESERVE_PROPERTY));
  return Number.isFinite(value) ? value : 0;
}

/**
 * An empty grid item spanning the dock's rows, so one ResizeObserver sees the
 * dock's height; it publishes the reserve on the column before paint.
 */
export function ComposerReserve() {
  const probeRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const probe = probeRef.current;
    const column = probe?.closest<HTMLElement>(".conversation-column");
    const host = column?.querySelector<HTMLElement>(".conversation-composer-host");
    if (!probe || !column || !host) return undefined;
    let state: ComposerReserveState = { reserve: -1, unfoldedHost: 0 };
    let dockHeight = -1;
    const measure = () => {
      const dock = Math.ceil(probe.getBoundingClientRect().height);
      if (dock !== dockHeight) column.style.setProperty(COMPOSER_DOCK_PROPERTY, `${dock}px`);
      dockHeight = dock;
      const next = resolveComposerReserve(state, {
        dock,
        host: host.getBoundingClientRect().height,
        folded: host.querySelector(".composer-zone.collapsed") !== null,
      });
      if (next.reserve !== state.reserve) column.style.setProperty(COMPOSER_RESERVE_PROPERTY, `${next.reserve}px`);
      state = next;
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    observer?.observe(probe);
    observer?.observe(host);
    return () => {
      observer?.disconnect();
      column.style.removeProperty(COMPOSER_RESERVE_PROPERTY);
      column.style.removeProperty(COMPOSER_DOCK_PROPERTY);
    };
  }, []);
  return <div ref={probeRef} className="composer-reserve-probe" aria-hidden="true" />;
}
