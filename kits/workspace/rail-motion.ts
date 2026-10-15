/** Where a thread sits in the rail's sections, drawn or not. */
export type RailPlace = { section: string; shelf: boolean; folded: boolean };

type Spot = { top: number; left: number; width: number; height: number };
type Snapshot = { spots: Map<string, Spot>; nodes: Map<string, HTMLElement>; headings: Map<string, Spot>; places: ReadonlyMap<string, RailPlace> };

const EASE = "cubic-bezier(.4, 0, .2, 1)";
// --motion for a short hop, up to --motion-slow across the whole rail.
const duration = (distance: number) => Math.min(320, 180 + Math.abs(distance) / 4);
// A project filter or a bulk settle swaps most of the list; that just cuts over.
const MAX_FADES = 30;
const ROW_SELECTOR = "[data-rail-thread], [data-rail-external]";

const idOf = (node: HTMLElement) => node.dataset.railThread ?? node.dataset.railExternal;
const progress = (animation: Animation) => animation.playState === "finished" ? 1 : animation.effect?.getComputedTiming().progress ?? 0;

/**
 * Moves the rail's rows between their places by thread, not by node, so a row
 * React remounts in another section still travels there. A row folded into a
 * shelf flies into its heading; one leaving a shelf rises out of it.
 */
export function createRailMotion(rows: HTMLElement) {
  const reduced = rows.ownerDocument.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)");
  const supported = typeof rows.animate === "function";
  let last: Snapshot | null = null;
  const travel = new Map<string, { animation: Animation; dy: number }>();
  const ghosts = new Set<HTMLElement>();

  const remaining = (id: string) => {
    const run = travel.get(id);
    return run ? run.dy * (1 - progress(run.animation)) : 0;
  };
  const spotOf = (node: Element, base: DOMRect): Spot => {
    const rect = node.getBoundingClientRect();
    return { top: rect.top - base.top, left: rect.left - base.left, width: rect.width, height: rect.height };
  };
  // Resting places: a running travel's offset is taken out.
  const measure = (places: ReadonlyMap<string, RailPlace>): Snapshot => {
    const base = rows.getBoundingClientRect();
    const nodes = new Map<string, HTMLElement>();
    const spots = new Map<string, Spot>();
    for (const node of rows.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
      const id = idOf(node);
      if (!id || nodes.has(id)) continue;
      const spot = spotOf(node, base);
      nodes.set(id, node);
      spots.set(id, { ...spot, top: spot.top - remaining(id) });
    }
    const headings = new Map<string, Spot>();
    for (const heading of rows.querySelectorAll<HTMLElement>("[data-rail-heading]")) headings.set(heading.dataset.railHeading!, spotOf(heading, base));
    return { spots, nodes, headings, places };
  };
  const stop = () => {
    for (const run of travel.values()) run.animation.cancel();
    travel.clear();
    for (const ghost of ghosts) ghost.remove();
    ghosts.clear();
  };
  const glide = (id: string, node: HTMLElement, keyframes: Keyframe[], dy: number) => {
    travel.get(id)?.animation.cancel();
    const animation = node.animate(keyframes, { duration: duration(dy), easing: EASE });
    travel.set(id, { animation, dy });
    animation.addEventListener("finish", () => { if (travel.get(id)?.animation === animation) travel.delete(id); }, { once: true });
  };
  const replay = (node: Element, name: string) => {
    node.classList.remove(name);
    void (node as HTMLElement).offsetWidth;
    node.classList.add(name);
    const done = (event: Event) => {
      if (!(event as AnimationEvent).animationName.startsWith("rail-")) return;
      node.classList.remove(name);
      node.removeEventListener("animationend", done);
    };
    node.addEventListener("animationend", done);
  };
  const pulse = (section: string) => {
    const heading = [...rows.querySelectorAll<HTMLElement>("[data-rail-heading]")].find((node) => node.dataset.railHeading === section);
    if (heading) replay(heading, "received");
  };
  // React owns the removed row; a noninteractive copy stays for the way out.
  const ghost = (node: HTMLElement, spot: Spot) => {
    const copy = node.cloneNode(true) as HTMLElement;
    for (const element of [copy, ...copy.querySelectorAll("*")]) {
      for (const name of ["id", "data-rail-thread", "data-rail-external", "data-rail-section", "data-cursor", "data-index"]) element.removeAttribute(name);
    }
    copy.setAttribute("aria-hidden", "true");
    copy.inert = true;
    copy.classList.add("rail-ghost");
    Object.assign(copy.style, { position: "absolute", top: `${spot.top}px`, left: `${spot.left}px`, width: `${spot.width}px`, height: `${spot.height}px`, margin: "0", transform: "none", translate: "none" });
    rows.append(copy);
    ghosts.add(copy);
    return copy;
  };
  const leave = (copy: HTMLElement, keyframes: Keyframe[], ms: number, then?: () => void) => {
    const animation = copy.animate(keyframes, { duration: ms, easing: EASE, fill: "forwards" });
    animation.addEventListener("finish", () => { copy.remove(); ghosts.delete(copy); then?.(); }, { once: true });
  };
  const centre = (spot: Spot) => spot.top + spot.height / 2;

  return {
    /** The rail's sections changed: every row goes from where it was to where it is. */
    update(places: ReadonlyMap<string, RailPlace>, animate: boolean) {
      if (!supported) return;
      const before = last;
      const next = measure(places);
      last = next;
      if (!before || !animate || reduced?.matches) { stop(); return; }

      const leaving = [...before.spots.keys()].filter((id) => !next.nodes.has(id));
      const arriving = [...next.nodes.keys()].filter((id) => !before.spots.has(id));
      if (leaving.length + arriving.length > MAX_FADES) { stop(); return; }
      const left = new Set(leaving);
      const received = new Set<string>();

      for (const id of leaving) {
        const node = before.nodes.get(id)!;
        const from = before.spots.get(id)!;
        const spot = { ...from, top: from.top + remaining(id) };
        travel.get(id)?.animation.cancel();
        travel.delete(id);
        const place = places.get(id);
        const heading = place?.folded ? next.headings.get(place.section) : undefined;
        if (heading) {
          const dy = centre(heading) - centre(spot);
          leave(ghost(node, spot), [
            { translate: "0 0", scale: "1", opacity: 1 },
            { offset: .6, opacity: .9 },
            { translate: `0 ${dy}px`, scale: ".9", opacity: 0 },
          ], duration(dy), () => pulse(place!.section));
        } else {
          leave(ghost(node, spot), [{ opacity: 1, scale: "1" }, { opacity: 0, scale: ".97" }], 160);
        }
      }

      for (const [id, node] of next.nodes) {
        const to = next.spots.get(id)!;
        const was = before.places.get(id);
        const now = places.get(id);
        const from = before.spots.get(id);
        if (from) {
          const dy = from.top + remaining(id) - to.top;
          const remounted = before.nodes.get(id) !== node;
          if (Math.abs(dy) < .5 && !remounted) continue;
          glide(id, node, remounted && Math.abs(from.height - to.height) > 2
            ? [{ translate: `0 ${dy}px`, opacity: .5 }, { translate: "0 0", opacity: 1 }]
            : [{ translate: `0 ${dy}px` }, { translate: "0 0" }], dy);
        } else if (!was) {
          glide(id, node, [{ translate: "0 -8px", opacity: 0 }, { translate: "0 0", opacity: 1 }], -8);
        } else if (was.folded && before.headings.has(was.section)) {
          const dy = centre(before.headings.get(was.section)!) - centre(to);
          glide(id, node, [{ translate: `0 ${dy}px`, opacity: 0 }, { offset: .4, opacity: 1 }, { translate: "0 0", opacity: 1 }], dy);
        } else if (was.section !== now?.section) {
          glide(id, node, [{ opacity: 0 }, { opacity: 1 }], 0);
        }
        // Back from a shelf means the thread wants the reader again.
        if (was?.shelf && now && !now.shelf) replay(node, "returned");
      }

      for (const [id, place] of places) {
        const was = before.places.get(id);
        if (place.folded && was?.section !== place.section && !left.has(id)) received.add(place.section);
      }
      for (const section of received) pulse(section);
    },
    /** Same sections, but rows may have been drawn, measured or resized. */
    refresh(places: ReadonlyMap<string, RailPlace>) {
      if (supported) last = measure(places);
    },
    dispose() {
      stop();
      last = null;
    },
  };
}
