import { expect, it } from "vitest";
import { bodyProfile, captureOrientation, captureRegion, captureSurface, nativeAngle, panelGeometry } from "./pose-model.js";
import { parseFoldState } from "./manager.js";
const open = { supported: true, posture: "opened", hingeAngle: 180 } as const;
const closed = { supported: true, posture: "closed", hingeAngle: 0 } as const;
it("identifies only named families and uses native support for an unnamed foldable", () => {
  expect(bodyProfile({ platform: "ios", name: "iPad Pro" }).layout).toBe("tablet");
  expect(bodyProfile({ platform: "android", name: "Pixel_Fold" }).layout).toBe("book");
  expect(bodyProfile({ platform: "android", name: "Galaxy Flip" }).layout).toBe("flip");
  expect(bodyProfile({ platform: "android", name: "Surface Duo" }).layout).toBe("dual");
  expect(bodyProfile({ platform: "android", name: "custom" }).layout).toBe("phone");
  expect(bodyProfile({ platform: "android", name: "custom" }, open)).toMatchObject({ layout: "book", identified: false });
  expect(bodyProfile({ platform: "ios", name: "Foldable iPhone" }, open).layout).toBe("phone");
});
it("rotates physical halves about the same front-plane hinge without changing capture coverage", () => {
  for (const layout of ["book", "dual", "flip"] as const) {
    const panels = panelGeometry(layout, 400, 600, 90);
    expect(panels).toHaveLength(2);
    expect(panels.reduce((area, panel) => area + panel.crop.width * panel.crop.height, 0)).toBe(1);
    if (layout === "flip") {
      expect(panels[0].y + panels[0].height).toBe(panels[1].y);
      expect(panels.map((panel) => panel.transform)).toEqual(["rotateX(-45deg)", "rotateX(45deg)"]);
      expect(panels[0].crop.y + panels[0].crop.height).toBe(panels[1].crop.y);
    } else {
      expect(panels[0].x + panels[0].width).toBe(panels[1].x);
      expect(panels.map((panel) => panel.transform)).toEqual(["rotateY(45deg)", "rotateY(-45deg)"]);
      expect(panels[0].crop.x + panels[0].crop.width).toBe(panels[1].crop.x);
    }
  }
  expect(panelGeometry("book", 400, 600, 0).map((panel) => panel.transform)).toEqual(["rotateY(90deg)", "rotateY(-90deg)"]);
  expect(panelGeometry("dual", 400, 600, 360).map((panel) => panel.transform)).toEqual(["rotateY(-90deg)", "rotateY(90deg)"]);
});
it("never maps an unknown or unchanged closed capture onto an invented cover display", () => {
  const inner = { width: 1800, height: 2200 }, cover = { width: 1000, height: 2200 };
  expect(captureSurface("book", inner, inner, open)).toBe("front");
  expect(captureSurface("book", cover, inner, open)).toBe("unmapped");
  expect(captureSurface("book", inner, inner, closed)).toBe("unmapped");
  expect(captureSurface("book", cover, undefined, closed)).toBe("unmapped");
  expect(captureSurface("book", cover, inner, closed)).toBe("cover");
  expect(captureSurface("flip", cover, inner, closed)).toBe("unmapped");
  expect(captureSurface("dual", inner, inner, closed)).toBe("unmapped");
  expect(captureSurface("book", inner, inner)).toBe("unmapped");
  expect(nativeAngle({ supported: false, posture: "closed", hingeAngle: 0 })).toBeUndefined();
  expect(nativeAngle({ ...open, hingeAngle: null })).toBe(180);
});
it("recognizes rotated interior captures without treating them as a closed cover", () => {
  const inner = { width: 1800, height: 2200 }, rotated = { width: 2200, height: 1800 }, cover = { width: 1000, height: 2200 };
  expect(captureOrientation(inner, inner)).toBe("same");
  expect(captureOrientation(rotated, inner)).toBe("rotated");
  expect(captureOrientation(cover, inner)).toBeUndefined();
  expect(captureOrientation({ width: 1801, height: 1800 }, { width: 1800, height: 1801 })).toBe("rotated");
  expect(captureOrientation({ width: 1800, height: 1800 }, { width: 1800, height: 1800 })).toBe("same");
  for (const layout of ["book", "flip", "dual"] as const) {
    expect(captureSurface(layout, rotated, inner, open)).toBe("front");
    expect(captureSurface(layout, rotated, inner, { ...open, posture: "half_opened", hingeAngle: 90 })).toBe("front");
    expect(captureSurface(layout, rotated, inner, closed)).toBe("unmapped");
    for (const posture of [null, "flipped", "tent"] as const) expect(captureSurface(layout, rotated, inner, { ...open, posture })).toBe("unmapped");
    expect(captureSurface(layout, rotated, inner, { ...open, supported: false })).toBe("unmapped");
    expect(captureSurface(layout, cover, inner, open)).toBe("unmapped");
  }
  expect(captureSurface("book", cover, rotated, closed)).toBe("cover");
});
it("rejects malformed native fold payloads rather than manufacturing supported posture", () => {
  expect(parseFoldState({ ok: true, fold: open })).toEqual(open);
  for (const fold of [{ posture: "closed" }, { ...open, hingeAngle: NaN }, { ...open, hingeAngle: 361 }, { ...open, posture: "requested" }, { ...open, supported: "yes" }]) expect(() => parseFoldState({ ok: true, fold })).toThrow("invalid fold state");
});

it("assigns the centre pixel of an odd-sized native video frame to one panel", () => {
  const size = { width: 1801, height: 2201 };
  const book = panelGeometry("book", 400, 600, 180).map((panel) => captureRegion(size, panel.crop));
  expect(book).toEqual([{ x: 0, y: 0, width: 900, height: 2201 }, { x: 900, y: 0, width: 901, height: 2201 }]);
  const flip = panelGeometry("flip", 400, 600, 180).map((panel) => captureRegion(size, panel.crop));
  expect(flip).toEqual([{ x: 0, y: 0, width: 1801, height: 1100 }, { x: 0, y: 1100, width: 1801, height: 1101 }]);
});
it("swaps physical hinge axes and disjoint pixel regions after a quarter-turn", () => {
  const size = { width: 2201, height: 1801 };
  for (const layout of ["book", "dual"] as const) {
    const panels = panelGeometry(layout, 600, 400, 90, true);
    expect(panels.map((panel) => panel.transform)).toEqual(["rotateX(-45deg)", "rotateX(45deg)"]);
    expect(panels[0].y + panels[0].height).toBe(panels[1].y);
    expect(panels.map((panel) => captureRegion(size, panel.crop))).toEqual([{ x: 0, y: 0, width: 2201, height: 900 }, { x: 0, y: 900, width: 2201, height: 901 }]);
  }
  const flip = panelGeometry("flip", 600, 400, 90, true);
  expect(flip.map((panel) => panel.transform)).toEqual(["rotateY(45deg)", "rotateY(-45deg)"]);
  expect(flip[0].x + flip[0].width).toBe(flip[1].x);
  expect(flip.map((panel) => captureRegion(size, panel.crop))).toEqual([{ x: 0, y: 0, width: 1100, height: 1801 }, { x: 1100, y: 0, width: 1101, height: 1801 }]);
});
