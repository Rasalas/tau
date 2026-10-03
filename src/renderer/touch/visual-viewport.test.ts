// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { editingFocused, tallestHeight, viewportFit } from "./visual-viewport";

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

  it("keeps the tablet sidebar full height beside the floating iPad shortcut bar", () => {
    expect(viewportFit(1180, { height: 1125, offsetTop: 0 }, undefined, true))
      .toEqual({ height: 1180, top: 0, keyboard: false });
    // A viewport pan must not move the whole sidebar off screen either.
    expect(viewportFit(1180, { height: 1125, offsetTop: 80 }, undefined, true))
      .toEqual({ height: 1180, top: 0, keyboard: false });
    // A full on-screen keyboard still needs the whole app to fit above it.
    expect(viewportFit(1180, { height: 780, offsetTop: 80 }, undefined, true))
      .toEqual({ height: 780, top: 80, keyboard: true });
  });

  it("says a keyboard is up where the web view shrinks the whole page while a field is focused", () => {
    // Android resizes the page: the visual viewport is as tall as the layout one.
    expect(viewportFit(500, { height: 500, offsetTop: 0 }, { tallest: 915, editing: true }).keyboard).toBe(true);
    // The same height with nothing to type into is a smaller window, not a keyboard.
    expect(viewportFit(500, { height: 500, offsetTop: 0 }, { tallest: 915, editing: false }).keyboard).toBe(false);
    // An iPad's hardware keyboard leaves its shortcut bar, well under a keyboard's height.
    expect(viewportFit(1180, { height: 1125, offsetTop: 0 }, { tallest: 1180, editing: true }).keyboard).toBe(false);
  });

  it("remembers the tallest page per width", () => {
    let tallest = tallestHeight(undefined, 412, 915);
    tallest = tallestHeight(tallest, 412, 500);
    expect(tallest).toEqual({ width: 412, height: 915 });
    expect(tallestHeight(tallest, 915, 412)).toEqual({ width: 915, height: 412 });
  });

  it("counts text fields and editable content as typing, and buttons and boxes not", () => {
    const make = (html: string) => { document.body.innerHTML = html; return document.body.firstElementChild; };
    expect(editingFocused(make("<textarea></textarea>"))).toBe(true);
    expect(editingFocused(make("<input type=\"search\">"))).toBe(true);
    expect(editingFocused(make("<input type=\"checkbox\">"))).toBe(false);
    expect(editingFocused(make("<button>Send</button>"))).toBe(false);
    expect(editingFocused(null)).toBe(false);
    const editable = make("<div contenteditable=\"true\"></div>") as HTMLElement;
    // jsdom computes no isContentEditable; a browser does.
    Object.defineProperty(editable, "isContentEditable", { value: true });
    expect(editingFocused(editable)).toBe(true);
  });
});
