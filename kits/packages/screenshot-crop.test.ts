import { describe, expect, it } from "vitest";
import { cropAround, toImagePixels } from "./screenshot-crop.js";

const viewport = { width: 1200, height: 800 };

describe("cropAround", () => {
  it("surrounds one region with the margin", () => {
    expect(cropAround([{ x: 300, y: 20, width: 100, height: 30 }], viewport, 10)).toEqual({ x: 290, y: 10, width: 120, height: 50 });
  });

  it("covers every region of the package", () => {
    const crop = cropAround([{ x: 100, y: 100, width: 50, height: 20 }, { x: 900, y: 700, width: 100, height: 40 }], viewport, 0);
    expect(crop).toEqual({ x: 100, y: 100, width: 900, height: 640 });
  });

  it("stays inside the page", () => {
    expect(cropAround([{ x: 0, y: 0, width: 40, height: 40 }, { x: 1180, y: 790, width: 100, height: 100 }], viewport, 48)).toEqual({ x: 0, y: 0, width: 1200, height: 800 });
  });

  it("ignores regions that are off screen or empty, and says nothing when none is left", () => {
    expect(cropAround([{ x: 2000, y: 0, width: 50, height: 50 }, { x: 10, y: 10, width: 0, height: 20 }], viewport)).toBeUndefined();
    expect(cropAround([], viewport)).toBeUndefined();
    expect(cropAround([{ x: 2000, y: 0, width: 50, height: 50 }, { x: 100, y: 100, width: 10, height: 10 }], viewport, 0)).toEqual({ x: 100, y: 100, width: 10, height: 10 });
  });

  it("falls back to the default margin for nonsense and caps a huge one", () => {
    const box = [{ x: 500, y: 400, width: 10, height: 10 }];
    expect(cropAround(box, viewport, Number.NaN)).toEqual({ x: 452, y: 352, width: 106, height: 106 });
    expect(cropAround(box, viewport, -5)).toEqual({ x: 500, y: 400, width: 10, height: 10 });
    expect(cropAround(box, viewport, 99_999)).toEqual({ x: 100, y: 0, width: 810, height: 800 });
  });
});

describe("toImagePixels", () => {
  it("scales the page's pixels to the picture's", () => {
    expect(toImagePixels({ x: 100, y: 50, width: 200, height: 40 }, viewport, { width: 2400, height: 1600 })).toEqual({ x: 200, y: 100, width: 400, height: 80 });
  });

  it("keeps the crop inside the picture", () => {
    expect(toImagePixels({ x: 1190, y: 790, width: 100, height: 100 }, viewport, { width: 1200, height: 800 })).toEqual({ x: 1190, y: 790, width: 10, height: 10 });
  });
});
