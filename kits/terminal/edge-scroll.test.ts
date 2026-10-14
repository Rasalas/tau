import { describe, expect, it } from "vitest";
import { dragEdgeY } from "./edge-scroll.js";

const flush = { top: 0, bottom: 800 };

describe("dragEdgeY", () => {
  it("puts a pointer in the bottom band outside the screen, farther the deeper it is", () => {
    const shallow = dragEdgeY(flush, 800, 794)!;
    const deep = dragEdgeY(flush, 800, 799)!;
    expect(shallow).toBeGreaterThan(800);
    expect(deep).toBeGreaterThan(shallow);
  });

  it("does the same at the top", () => {
    const shallow = dragEdgeY(flush, 800, 6)!;
    const deep = dragEdgeY(flush, 800, 0)!;
    expect(shallow).toBeLessThan(0);
    expect(deep).toBeLessThan(shallow);
  });

  it("leaves the middle of the screen and a pointer already outside to xterm", () => {
    expect(dragEdgeY(flush, 800, 400)).toBeUndefined();
    expect(dragEdgeY(flush, 800, 790)).toBeUndefined();
    expect(dragEdgeY(flush, 800, 900)).toBeUndefined();
    expect(dragEdgeY(flush, 800, -3)).toBeUndefined();
  });

  it("leaves an edge alone that is not the window's, where the pointer can leave the screen", () => {
    expect(dragEdgeY({ top: 100, bottom: 700 }, 800, 699)).toBeUndefined();
    expect(dragEdgeY({ top: 100, bottom: 700 }, 800, 101)).toBeUndefined();
  });

  it("measures a screen taller than the window against the window", () => {
    expect(dragEdgeY({ top: -50, bottom: 900 }, 800, 799)).toBeGreaterThan(900);
    expect(dragEdgeY({ top: -50, bottom: 900 }, 800, 1)).toBeLessThan(-50);
  });
});
