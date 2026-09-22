// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  previewAnnotateCollect,
  previewAnnotateEnd,
  previewAnnotateStart,
  previewDescribe,
  previewPickArm,
  previewPickCancel,
  previewPickPoll,
  previewSelector,
  type PreviewPickedElement,
} from "./page-overlay.js";
import { pageCall } from "./page-script.js";

beforeEach(() => {
  document.title = "Fixture";
  document.body.innerHTML = `
    <main>
      <ul class="menu main">
        <li><a href="/a">A</a></li>
        <li><a href="/b" class="current">B</a></li>
      </ul>
      <section id="hero"><h1>Welcome   home</h1><button class="btn primary" type="button">Save changes</button></section>
      <div><span>one</span><span>two</span></div>
    </main>`;
});

afterEach(() => {
  previewPickCancel();
  previewAnnotateEnd();
});

const mouse = (target: EventTarget, type: string, x = 0, y = 0) =>
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));

describe("element selectors", () => {
  it("names an element by the shortest path that matches it alone", () => {
    expect(previewSelector(document.querySelector("#hero")!)).toBe("#hero");
    expect(previewSelector(document.querySelector("#hero button")!)).toBe("button.btn.primary");
    expect(previewSelector(document.querySelector("a.current")!)).toBe("a.current");
    const second = document.querySelectorAll("span")[1]!;
    const selector = previewSelector(second);
    expect(document.querySelectorAll(selector)).toHaveLength(1);
    expect(document.querySelector(selector)).toBe(second);
  });
});

describe("pick mode", () => {
  it("describes the clicked element and swallows the click", async () => {
    const button = document.querySelector("button")!;
    let pageSawClick = false;
    button.addEventListener("click", () => { pageSawClick = true; });
    expect(previewPickArm(previewDescribe, previewSelector)).toBe(true);
    await expect(previewPickPoll()).resolves.toEqual({ state: "armed" });
    mouse(button, "mousemove");
    mouse(button, "click");
    expect(pageSawClick).toBe(false);
    const poll = await previewPickPoll();
    expect(poll.state).toBe("done");
    const element = (poll as { element: PreviewPickedElement }).element;
    expect(element).toMatchObject({ selector: "button.btn.primary", tag: "button", text: "Save changes", title: "Fixture" });
    expect(element.html).toBe('<button class="btn primary" type="button">Save changes</button>');
    expect(element.rect).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    // Settled: the highlight is gone and the page has its clicks back.
    await expect(previewPickPoll()).resolves.toEqual({ state: "missing" });
    button.click();
    expect(pageSawClick).toBe(true);
  });

  it("gives up on Escape and on cancel", async () => {
    previewPickArm(previewDescribe, previewSelector);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await expect(previewPickPoll()).resolves.toEqual({ state: "cancelled" });
    previewPickArm(previewDescribe, previewSelector);
    expect(previewPickCancel()).toBe(true);
    await expect(previewPickPoll()).resolves.toEqual({ state: "missing" });
  });

  it("trims long text and markup", () => {
    document.body.innerHTML = `<p>${"word ".repeat(400)}</p>`;
    const described = previewDescribe(document.querySelector("p")!, previewSelector);
    expect(described.text.length).toBe(501);
    expect(described.html.endsWith("…")).toBe(true);
  });

  it("travels to the page as source that runs there", () => {
    const source = pageCall(previewPickArm, previewDescribe, previewSelector);
    // eslint-disable-next-line no-eval -- the page would do exactly this.
    expect(eval(source)).toBe(true);
    expect(document.documentElement.querySelectorAll(":scope > div")).toHaveLength(2);
  });
});

describe("annotate mode", () => {
  const layer = () => document.querySelector<HTMLElement>("[data-tau-annotate]")!;

  it("draws a numbered rectangle and an arrow, each with its note", async () => {
    previewAnnotateStart("rect");
    mouse(layer(), "mousedown", 110, 60);
    mouse(window, "mousemove", 150, 90);
    mouse(window, "mouseup", 210, 140);
    const field = layer().querySelector("input")!;
    field.value = "  too much padding ";
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));

    previewAnnotateStart("arrow");
    mouse(layer(), "mousedown", 300, 300);
    mouse(window, "mouseup", 250, 200);
    // A click without a drag leaves no mark.
    mouse(layer(), "mousedown", 400, 400);
    mouse(window, "mouseup", 401, 401);

    previewAnnotateStart("note");
    mouse(layer(), "mousedown", 20, 30);
    const open = [...layer().querySelectorAll("input")].at(-1)!;
    open.value = "missing icon";

    const result = await previewAnnotateCollect();
    expect(result).toMatchObject({ title: "Fixture" });
    expect(result!.items).toEqual([
      { n: 1, kind: "rect", x: 110, y: 60, width: 100, height: 80, note: "too much padding" },
      { n: 2, kind: "arrow", x: 300, y: 300, toX: 250, toY: 200, note: "" },
      { n: 3, kind: "note", x: 20, y: 30, note: "missing icon" },
    ]);
    // The notes are drawn for the capture; no field is left open.
    expect(layer().querySelectorAll("input")).toHaveLength(0);
    expect(layer().textContent).toContain("1. too much padding");
    expect(layer().textContent).toContain("3. missing icon");
    expect(previewAnnotateEnd()).toBe(true);
    expect(document.querySelector("[data-tau-annotate]")).toBeNull();
    await expect(previewAnnotateCollect()).resolves.toBeNull();
  });

  it("commits a note whose field blurs as it is removed, the way Chromium does", async () => {
    const remove = HTMLInputElement.prototype.remove;
    HTMLInputElement.prototype.remove = function removeWithBlur(this: HTMLInputElement) {
      this.dispatchEvent(new FocusEvent("blur"));
      remove.call(this);
    };
    try {
      previewAnnotateStart("note");
      mouse(layer(), "mousedown", 20, 30);
      layer().querySelector("input")!.value = "left open";
      const result = await previewAnnotateCollect();
      expect(result!.items).toEqual([{ n: 1, kind: "note", x: 20, y: 30, note: "left open" }]);
      expect(layer().textContent).toBe("11. left open");
    } finally {
      HTMLInputElement.prototype.remove = remove;
    }
  });

  it("switches the tool of a layer that is already up", () => {
    previewAnnotateStart("rect");
    const first = layer();
    previewAnnotateStart("note");
    expect(layer()).toBe(first);
    expect(document.querySelectorAll("[data-tau-annotate]")).toHaveLength(1);
  });
});
