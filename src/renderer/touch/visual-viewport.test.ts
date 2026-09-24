import { describe, expect, it } from "vitest";
import { viewportFit } from "./visual-viewport";

describe("the page beside an on-screen keyboard", () => {
  it("takes the visual viewport's height and says when a keyboard covers the rest", () => {
    expect(viewportFit(844, { height: 844, offsetTop: 0 })).toEqual({ height: 844, top: 0, keyboard: false });
    expect(viewportFit(844, { height: 508.4, offsetTop: 0 })).toEqual({ height: 508, top: 0, keyboard: true });
    // iOS scrolls the layout viewport up while the keyboard is open.
    expect(viewportFit(844, { height: 508, offsetTop: 120 })).toEqual({ height: 508, top: 120, keyboard: true });
  });

  it("treats a toolbar that folds away as no keyboard, and a browser without the API as full height", () => {
    expect(viewportFit(844, { height: 790, offsetTop: 0 }).keyboard).toBe(false);
    expect(viewportFit(700, undefined)).toEqual({ height: 700, top: 0, keyboard: false });
  });
});
