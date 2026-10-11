import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { PullRequestGuide } from "./guide-protocol.js";
import type { ExcerptEnv } from "./guide-excerpt.js";
import { GuideRail } from "./guide-rail.js";
import { GuideStop } from "./guide-stop.js";
import { clampPosition, guideProgress, guideProgressKey, stepTourPosition } from "./guide-tour.js";

/** The widths at which the rail sits beside the stop, and the notes get a column of their own. */
const RAIL_AT = 860;
const NOTES_AT = 1280;

/** The panel's width, followed as it is dragged; unknown (0) where nothing can measure. */
function useWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(element.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

function editable(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.closest('[contenteditable=""], [contenteditable="true"]') !== null);
}

/** J and K step through the tour while it is the tab on screen, unless the reader types or a dialog (the palette) is open. */
function useStepKeys(active: boolean, root: React.RefObject<HTMLElement | null>, step: (delta: 1 | -1) => void) {
  const latest = useRef(step);
  latest.current = step;
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (event.key !== "j" && event.key !== "k") return;
      if (editable(event.target) || document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      // A tab that is kept but hidden is not the one on screen.
      if (!root.current || root.current.closest("[hidden]")) return;
      event.preventDefault();
      latest.current(event.key === "j" ? 1 : -1);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [active, root]);
}

/**
 * The guide as a tour: a rail of stops beside the stop being read. Progress is held per guide head
 * for as long as the window is open, so the same guide in another panel opens where the reader is.
 */
export function GuideTourView({ guide, url, banner, active, env, onAsk, onFinish }: {
  guide: PullRequestGuide;
  url: string;
  /** The stale, running or failed notice above the stop. */
  banner: ReactNode;
  /** Whether the tour is the tab on screen, which is when J and K step through it. */
  active: boolean;
  env: ExcerptEnv;
  /** Starts the conversation about stop `index`; null where no composer can take it. */
  onAsk: ((index: number, question: string) => void) | null;
  onFinish: (() => void) | null;
}) {
  const key = guideProgressKey(url, guide.headSha);
  const progress = useSyncExternalStore(guideProgress.subscribe, () => guideProgress.get(key));
  const [railOpen, setRailOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const width = useWidth(root);
  const count = guide.stops.length;
  const position = clampPosition(progress.position, count);
  const stop = guide.stops[position];

  const goTo = useCallback((next: number) => {
    guideProgress.go(key, next);
    setRailOpen(false);
    // A new stop starts at its top, wherever the panel around the tour scrolls.
    root.current?.scrollIntoView?.({ block: "start" });
  }, [key]);
  const step = (delta: 1 | -1) => goTo(stepTourPosition(position, delta, count));
  useStepKeys(active, root, step);

  const narrow = width < RAIL_AT;
  const rail = <GuideRail stops={guide.stops} position={position} seen={progress.seen} onSelect={goTo} />;
  return (
    <div ref={root} className="guide-tour">
      <div className={`guide-grid${narrow ? "" : " with-rail"}`}>
        {narrow ? null : <aside className="guide-rail-column">{rail}</aside>}
        <main>
          {banner}
          {stop ? (
            <GuideStop
              key={position}
              stop={stop}
              index={position}
              count={count}
              narrow={narrow}
              notesColumn={width >= NOTES_AT}
              railOpen={railOpen}
              onRailOpenChange={setRailOpen}
              stopList={rail}
              nextTitle={guide.stops[position + 1]?.title ?? null}
              env={env}
              onStep={step}
              onAsk={onAsk ? (question) => onAsk(position, question) : null}
              onFinish={onFinish ? () => { guideProgress.markSeen(key, position); onFinish(); } : null}
            />
          ) : <p className="pr-empty">This change has no files to tour.</p>}
        </main>
      </div>
    </div>
  );
}
