import { describe, expect, it } from "vitest";
import { annotationExcerpt, pickCrop, pickedElementExcerpt, readAnnotationResult, readPickedElement, shortUrl } from "./picks.js";

const ELEMENT = {
  url: "http://localhost:8000/settings",
  title: "Settings",
  selector: "form > button.primary",
  tag: "button",
  text: "Save changes",
  rect: { x: 40, y: 300, width: 120, height: 32 },
  html: "<button class=\"primary\">Save changes</button>",
  viewport: { width: 1024, height: 700 },
};

describe("picked element payload", () => {
  it("takes a well-formed element and nothing else", () => {
    expect(readPickedElement(ELEMENT)).toEqual(ELEMENT);
    expect(readPickedElement({ ...ELEMENT, rect: { x: "40", y: 0, width: 1, height: 1 } })).toBeUndefined();
    expect(readPickedElement({ ...ELEMENT, selector: "" })).toBeUndefined();
    expect(readPickedElement({ ...ELEMENT, viewport: null })).toBeUndefined();
    expect(readPickedElement([ELEMENT])).toBeUndefined();
    expect(readPickedElement("button")).toBeUndefined();
  });

  it("caps what a hostile page could make huge", () => {
    const read = readPickedElement({ ...ELEMENT, html: "x".repeat(100_000), tag: "t".repeat(500) });
    expect(read?.html).toHaveLength(4_000);
    expect(read?.tag).toHaveLength(60);
  });

  it("becomes an excerpt the agent can act on", () => {
    const excerpt = pickedElementExcerpt(ELEMENT, true);
    expect(excerpt.label).toBe("<button> · localhost:8000/settings");
    expect(excerpt.source).toBe('the Preview, an element the user picked on http://localhost:8000/settings ("Settings"); the attached image shows it');
    expect(excerpt.text).toBe([
      "selector: form > button.primary",
      "tag: <button>",
      'text: "Save changes"',
      "box: x=40 y=300 120×32 (CSS px, viewport 1024×700)",
      "html:",
      "<button class=\"primary\">Save changes</button>",
    ].join("\n"));
    expect(pickedElementExcerpt({ ...ELEMENT, text: "", title: "" }, false).source).toBe("the Preview, an element the user picked on http://localhost:8000/settings");
    expect(pickedElementExcerpt({ ...ELEMENT, text: "" }, false).text).not.toContain("text:");
  });

  it("cuts the element with a margin, inside the viewport", () => {
    expect(pickCrop(ELEMENT.rect, ELEMENT.viewport)).toEqual({ x: 32, y: 292, width: 136, height: 48 });
    expect(pickCrop({ x: -20, y: 690, width: 50, height: 40 }, ELEMENT.viewport)).toEqual({ x: 0, y: 682, width: 38, height: 18 });
    expect(pickCrop({ x: 2_000, y: 10, width: 50, height: 40 }, ELEMENT.viewport)).toBeUndefined();
  });

  it("shortens URLs for a label", () => {
    expect(shortUrl("http://localhost:8000/")).toBe("localhost:8000");
    expect(shortUrl("https://example.com/a/b?c=1")).toBe("example.com/a/b");
    expect(shortUrl("file:///project/dist/index.html")).toBe("index.html");
    expect(shortUrl("not a url")).toBe("not a url");
  });
});

describe("annotation serialization", () => {
  const RESULT = {
    url: "http://localhost:8000/",
    title: "Home",
    viewport: { width: 800, height: 600 },
    items: [
      { n: 1, kind: "rect", x: 10, y: 20, width: 100, height: 40, note: "too much padding" },
      { n: 2, kind: "arrow", x: 300, y: 300, toX: 250, toY: 200, note: "" },
      { n: 3, kind: "note", x: 20, y: 30, note: "missing icon" },
    ],
  };

  it("reads what the page collected, and refuses a mark of an unknown kind", () => {
    expect(readAnnotationResult(RESULT)).toEqual(RESULT);
    expect(readAnnotationResult({ ...RESULT, items: [{ ...RESULT.items[0], kind: "circle" }] })).toBeUndefined();
    expect(readAnnotationResult({ ...RESULT, items: [{ ...RESULT.items[0], note: 5 }] })).toBeUndefined();
    expect(readAnnotationResult({ ...RESULT, items: "none" })).toBeUndefined();
    expect(readAnnotationResult(null)).toBeUndefined();
  });

  it("numbers the marks the way the image does", () => {
    const excerpt = annotationExcerpt(readAnnotationResult(RESULT)!, true);
    expect(excerpt.label).toBe("3 annotations · localhost:8000");
    expect(excerpt.source).toBe('the Preview, annotations the user drew on http://localhost:8000/ ("Home"); the attached image shows the page with them, numbered');
    expect(excerpt.text).toBe([
      "viewport: 800×600 CSS px",
      "1. rectangle at x=10 y=20, 100×40: too much padding",
      "2. arrow from (300, 300) to (250, 200) (no note)",
      "3. note at (20, 30): missing icon",
    ].join("\n"));
    expect(annotationExcerpt({ ...RESULT, items: [] } as never, false)).toMatchObject({
      label: "0 annotations · localhost:8000",
      text: "viewport: 800×600 CSS px\n(the user drew nothing)",
    });
  });
});
