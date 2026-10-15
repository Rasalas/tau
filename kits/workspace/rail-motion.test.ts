// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRailMotion, type RailPlace } from "./rail-motion";

type Played = { node: HTMLElement; keyframes: Keyframe[]; animation: Animation };

describe("rail motion", () => {
  let played: Played[];
  let rows: HTMLElement;
  const tops = new Map<Element, number>();

  beforeEach(() => {
    played = [];
    rows = document.createElement("div");
    document.body.append(rows);
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const top = tops.get(this) ?? 0;
      return { top, left: 0, width: 200, height: 40, bottom: top + 40, right: 200, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
    });
    Object.defineProperty(HTMLElement.prototype, "animate", {
      configurable: true,
      value(this: HTMLElement, keyframes: Keyframe[]) {
        const animation = Object.assign(new EventTarget(), { playState: "running", cancel: () => undefined, effect: { getComputedTiming: () => ({ progress: 0 }) } }) as unknown as Animation;
        played.push({ node: this, keyframes, animation });
        return animation;
      },
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete (HTMLElement.prototype as { animate?: unknown }).animate;
    rows.remove();
    tops.clear();
  });

  const row = (id: string, top: number) => {
    const node = document.createElement("div");
    node.className = "rail-row";
    node.dataset.railThread = id;
    tops.set(node, top);
    rows.append(node);
    return node;
  };
  const heading = (id: string, top: number) => {
    const node = document.createElement("button");
    node.dataset.railHeading = id;
    tops.set(node, top);
    rows.append(node);
    return node;
  };
  const places = (entries: Record<string, RailPlace>) => new Map(Object.entries(entries));
  const active: RailPlace = { section: "active", shelf: false, folded: false };
  const working: RailPlace = { section: "working", shelf: true, folded: true };

  it("flies a row into the folded shelf it joins and marks the shelf when it lands", () => {
    const motion = createRailMotion(rows);
    const alpha = row("alpha", 0);
    const shelf = heading("working", 400);
    motion.update(places({ alpha: active }), true);

    alpha.remove();
    motion.update(places({ alpha: working }), true);

    const ghost = rows.querySelector<HTMLElement>(".rail-ghost")!;
    expect(ghost.dataset.railThread).toBeUndefined();
    expect(ghost.getAttribute("aria-hidden")).toBe("true");
    const flight = played.find((entry) => entry.node === ghost)!;
    expect(flight.keyframes.at(-1)).toMatchObject({ translate: "0 400px", opacity: 0 });
    expect(shelf.classList.contains("received")).toBe(false);
    flight.animation.dispatchEvent(new Event("finish"));
    expect(rows.querySelector(".rail-ghost")).toBeNull();
    expect(shelf.classList.contains("received")).toBe(true);
  });

  it("raises a row out of the folded shelf it leaves and marks it as back", () => {
    const motion = createRailMotion(rows);
    heading("working", 400);
    motion.update(places({ alpha: working }), true);

    const alpha = row("alpha", 0);
    motion.update(places({ alpha: active }), true);

    const rise = played.find((entry) => entry.node === alpha)!;
    expect(rise.keyframes[0]).toMatchObject({ translate: "0 400px", opacity: 0 });
    expect(alpha.classList.contains("returned")).toBe(true);
  });

  it("glides a row to its new place, even when it was drawn anew", () => {
    const motion = createRailMotion(rows);
    const first = row("alpha", 0);
    row("beta", 44);
    motion.update(places({ alpha: active, beta: active }), true);

    first.remove();
    const moved = row("alpha", 88);
    motion.update(places({ alpha: active, beta: active }), true);

    expect(played.find((entry) => entry.node === moved)?.keyframes[0]).toMatchObject({ translate: "0 -88px" });
  });

  it("does not move rows that a refresh only measured", () => {
    const motion = createRailMotion(rows);
    const alpha = row("alpha", 0);
    motion.update(places({ alpha: active }), true);
    tops.set(alpha, 20);
    motion.refresh(places({ alpha: active }));
    motion.update(places({ alpha: active }), true);
    expect(played).toEqual([]);
  });

  it("cuts over when told not to animate", () => {
    const motion = createRailMotion(rows);
    const alpha = row("alpha", 0);
    motion.update(places({ alpha: active }), true);
    tops.set(alpha, 200);
    motion.update(places({ alpha: active }), false);
    expect(played).toEqual([]);
  });
});
